import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";

const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
export const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
export const grantsSchema = z.strictObject({
  read: z.array(scopeSchema).max(8),
  write: z.array(scopeSchema).max(8),
  process: z.array(scopeSchema).max(8),
});
export type Grants = z.infer<typeof grantsSchema>;
export interface RegisteredClient {
  id: string;
  name: string;
  redirects: string[];
  grants: Grants;
  defaultWrite: string | null;
  created: number;
  lastUsed: number | null;
  revoked: boolean;
  kind: "oauth" | "cli";
  refresh: boolean;
}
export interface TokenRecord {
  id: string;
  clientId: string;
  kind: "cli" | "access" | "refresh" | "code";
  resource: string;
  grants: Grants;
  defaultWrite: string | null;
  scopes: string[];
  expires: number;
  created: number;
  family: string;
  familyExpires: number;
  used: boolean;
  revoked: boolean;
  redirect?: string;
  challenge?: string;
}
export interface BrowserSession {
  csrf: string;
  password: boolean;
  authenticated: boolean;
  challenge?: string;
  ceremony?: "register" | "authenticate";
  pending?: {
    clientId: string;
    redirect: string;
    challenge: string;
    state: string;
    scopes: string[];
  };
}
export interface Passkey {
  id: string;
  publicKey: string;
  counter: number;
}

export class AuthStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly areas: readonly string[],
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS auth_clients(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_tokens(hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, family TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_token_family ON auth_tokens(family);
      CREATE INDEX IF NOT EXISTS auth_token_expiry ON auth_tokens(expires);
      CREATE TABLE IF NOT EXISTS auth_owner(id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_passkeys(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  validateGrants(input: Grants, defaultWrite: string | null) {
    const grants = grantsSchema.parse(input);
    for (const list of Object.values(grants)) {
      if (
        new Set(list).size !== list.length ||
        list.some((a) => !this.areas.includes(a))
      )
        throw new Error("Invalid grants");
    }
    if (defaultWrite !== null && !grants.write.includes(defaultWrite))
      throw new Error("Default must be writable");
    if (grants.write.length && defaultWrite === null)
      throw new Error("Choose a default write area");
    return grants;
  }
  listClients(): RegisteredClient[] {
    return this.db
      .prepare("SELECT data FROM auth_clients ORDER BY id")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  client(id: string): RegisteredClient {
    const row = this.db
      .prepare("SELECT data FROM auth_clients WHERE id=?")
      .get(id);
    if (!row) throw new Error("Unknown client");
    const client: RegisteredClient = JSON.parse(row.data as string);
    if (client.revoked) throw new Error("Revoked client");
    return client;
  }
  saveClient(client: RegisteredClient) {
    this.db
      .prepare(
        "INSERT INTO auth_clients VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(client.id, JSON.stringify(client));
  }
  register(
    name: string,
    redirects: string[],
    refresh: boolean,
  ): RegisteredClient {
    if (this.listClients().filter((c) => !c.revoked).length >= 256)
      throw new Error("Client limit");
    const client: RegisteredClient = {
      id: secret(),
      name,
      redirects,
      refresh,
      grants: { read: [], write: [], process: [] },
      defaultWrite: null,
      created: this.now(),
      lastUsed: null,
      revoked: false,
      kind: "oauth",
    };
    this.saveClient(client);
    return client;
  }
  revokeClient(id: string) {
    const client = this.client(id);
    client.revoked = true;
    this.saveClient(client);
  }
  createCliToken(
    name: string,
    input: Grants,
    defaultWrite: string | null,
    lifetime: number,
    resource: string,
  ) {
    if (
      !/^[a-zA-Z0-9._-]{1,80}$/.test(name) ||
      !Number.isInteger(lifetime) ||
      lifetime < 60 ||
      lifetime > 365 * 86400
    )
      throw new Error("Invalid token options");
    const grants = this.validateGrants(input, defaultWrite);
    return this.transaction(() => {
      let client = this.listClients().find(
        (c) => c.name === name && c.kind === "cli",
      );
      if (client?.revoked) throw new Error("Revoked client");
      if (!client) {
        if (this.listClients().filter((c) => !c.revoked).length >= 256)
          throw new Error("Client limit");
        client = {
          id: secret(),
          name,
          redirects: [],
          refresh: false,
          grants,
          defaultWrite,
          created: this.now(),
          lastUsed: null,
          revoked: false,
          kind: "cli",
        };
      } else {
        for (const op of ["read", "write", "process"] as const)
          client.grants[op] = [
            ...new Set([...client.grants[op], ...grants[op]]),
          ];
        client.defaultWrite = defaultWrite ?? client.defaultWrite;
      }
      this.saveClient(client);
      return this.issue({
        clientId: client.id,
        kind: "cli",
        resource,
        grants,
        defaultWrite,
        scopes: grantScopes(grants),
        expires: this.now() + lifetime,
        family: secret(),
        familyExpires: this.now() + lifetime,
      });
    });
  }
  issue(input: Omit<TokenRecord, "id" | "created" | "used" | "revoked">) {
    // Keep spent refresh hashes until every descendant has expired, for replay detection.
    this.db
      .prepare(
        "DELETE FROM auth_tokens WHERE expires < ? AND json_extract(data, '$.kind') != 'cli'",
      )
      .run(this.now() - 300);
    const token = secret(),
      id = secret();
    const record: TokenRecord = {
      ...input,
      id,
      created: this.now(),
      used: false,
      revoked: false,
    };
    this.db
      .prepare("INSERT INTO auth_tokens VALUES (?,?,?,?,?)")
      .run(
        digest(token),
        id,
        input.family,
        input.familyExpires,
        JSON.stringify(record),
      );
    return { token, id, record };
  }
  token(value: string): TokenRecord {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid token");
    const row = this.db
      .prepare("SELECT data FROM auth_tokens WHERE hash=?")
      .get(digest(value));
    if (!row) throw new Error("Invalid token");
    return JSON.parse(row.data as string);
  }
  saveToken(record: TokenRecord) {
    this.db
      .prepare("UPDATE auth_tokens SET data=? WHERE id=?")
      .run(JSON.stringify(record), record.id);
  }
  revokeFamily(family: string) {
    // One statement serializes with rotation, including from a separate CLI process.
    this.db
      .prepare(
        "UPDATE auth_tokens SET data=json_set(data, '$.revoked', json('true')) WHERE family=?",
      )
      .run(family);
  }
  revokeToken(id: string) {
    const row = this.db
      .prepare("SELECT data FROM auth_tokens WHERE id=?")
      .get(id);
    if (!row) throw new Error("Unknown token");
    this.revokeFamily((JSON.parse(row.data as string) as TokenRecord).family);
  }
  listTokens() {
    return this.db
      .prepare("SELECT data FROM auth_tokens ORDER BY id")
      .all()
      .map((r) => {
        const t: TokenRecord = JSON.parse(r.data as string);
        return {
          id: t.id,
          clientId: t.clientId,
          kind: t.kind,
          grants: t.grants,
          defaultWrite: t.defaultWrite,
          created: t.created,
          expires: t.expires,
          revoked: t.revoked,
          used: t.used,
        };
      });
  }
  access(value: string, resource: string) {
    const token = this.token(value);
    if (
      !["cli", "access"].includes(token.kind) ||
      token.revoked ||
      token.expires <= this.now() ||
      token.resource !== resource
    )
      throw new Error("Invalid token");
    const client = this.client(token.clientId);
    const grants: Grants = { read: [], write: [], process: [] };
    for (const op of ["read", "write", "process"] as const)
      grants[op] = token.grants[op].filter(
        (a) => this.areas.includes(a) && client.grants[op].includes(a),
      );
    client.lastUsed = this.now();
    // Never overwrite grants/revocation from a stale client read while the CLI writes.
    this.db
      .prepare(
        "UPDATE auth_clients SET data=json_set(data, '$.lastUsed', ?) WHERE id=?",
      )
      .run(client.lastUsed, client.id);
    return { ...token, grants, client };
  }
  async initOwner(password: string) {
    if (password.length < 12 || password.length > 1024)
      throw new Error("Password must be 12–1024 characters");
    const salt = secret();
    const hash = await derive(password, salt);
    this.db
      .prepare("INSERT INTO auth_owner VALUES (1,?,?)")
      .run(salt, hash.toString("base64url"));
  }
  async checkPassword(password: string) {
    const row = this.db
      .prepare("SELECT salt,password FROM auth_owner WHERE id=1")
      .get();
    const hash = await derive(
      password.slice(0, 1025),
      (row?.salt as string) ?? "uninitialized-owner",
    );
    return (
      !!row &&
      password.length <= 1024 &&
      equal(hash.toString("base64url"), row.password as string)
    );
  }
  hasOwner() {
    return !!this.db.prepare("SELECT id FROM auth_owner WHERE id=1").get();
  }
  passkeys(): Passkey[] {
    return this.db
      .prepare("SELECT data FROM auth_passkeys")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  savePasskey(key: Passkey) {
    this.db
      .prepare(
        "INSERT INTO auth_passkeys VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(key.id, JSON.stringify(key));
  }
  newSession(data: BrowserSession) {
    const value = secret();
    this.db
      .prepare("DELETE FROM auth_sessions WHERE expires<=?")
      .run(this.now());
    const count = this.db
      .prepare("SELECT count(*) AS n FROM auth_sessions")
      .get();
    if (Number(count?.n) >= 1024) throw new Error("Session limit");
    this.db
      .prepare("INSERT INTO auth_sessions VALUES (?,?,?)")
      .run(digest(value), this.now() + 600, JSON.stringify(data));
    return value;
  }
  session(value: string): BrowserSession {
    const row = this.db
      .prepare("SELECT data FROM auth_sessions WHERE hash=? AND expires>?")
      .get(digest(value), this.now());
    if (!row) throw new Error("Session expired");
    return JSON.parse(row.data as string);
  }
  saveSession(value: string, data: BrowserSession) {
    this.db
      .prepare("UPDATE auth_sessions SET data=? WHERE hash=? AND expires>?")
      .run(JSON.stringify(data), digest(value), this.now());
  }
  deleteSession(value: string) {
    this.db
      .prepare("DELETE FROM auth_sessions WHERE hash=?")
      .run(digest(value));
  }
  time() {
    return this.now();
  }
}
export function grantScopes(grants: Grants) {
  return [
    ...new Set(
      (["read", "write", "process"] as const).flatMap((op) =>
        grants[op].length ? [`context:${op}`, ...grants[op]] : [],
      ),
    ),
  ];
}
