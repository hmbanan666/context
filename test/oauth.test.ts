import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthStore } from "../src/auth-store.js";
import { AuthorizationServer } from "../src/oauth.js";

const resource = "https://context.example/mcp";
const config = {
  resource,
  issuer: "https://context.example",
  areas: ["personal", "garden"],
  refreshSeconds: 86400,
  offlineSeconds: 30 * 86400,
};

test("MCP discovery advertises DCR, S256 and separate offline consent", async () => {
  const store = new AuthStore(":memory:", config.areas);
  const auth = new AuthorizationServer(store, config);
  try {
    const meta = await auth.fetch(
      new Request(`${config.issuer}/.well-known/oauth-authorization-server`),
    );
    assert.equal(meta.status, 200);
    const body = await meta.json();
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.equal(body.registration_endpoint, `${config.issuer}/oauth/register`);
    const res = await auth.fetch(
      new Request(`${config.issuer}/.well-known/oauth-protected-resource/mcp`),
    );
    assert.equal(
      (await res.json()).scopes_supported.includes("offline_access"),
      false,
    );
    const registered = await auth.fetch(
      new Request(`${config.issuer}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Fictional MCP client",
          redirect_uris: ["http://127.0.0.1:4567/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      }),
    );
    assert.equal(registered.status, 201);
    const client = await registered.json();
    assert.ok(client.client_id);
    assert.deepEqual(store.client(client.client_id).grants, {
      read: [],
      write: [],
      process: [],
    });
  } finally {
    store.close();
  }
});

import {
  Client,
  discoverOAuthMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { protectMcp } from "../src/auth.js";
import { digest, secret } from "../src/auth-store.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";
import { SoftwareAuthenticator } from "./fixtures/authenticator.js";

const password = "fictional owner password 123";
class Browser {
  cookie = "";
  csrf = "";
  constructor(readonly auth: AuthorizationServer) {}
  async request(
    path: string,
    body?: Record<string, unknown> | URLSearchParams,
  ) {
    const headers: Record<string, string> = {
      cookie: this.cookie,
      origin: config.issuer,
    };
    if (body)
      headers["content-type"] =
        body instanceof URLSearchParams
          ? "application/x-www-form-urlencoded"
          : "application/json";
    const response = await this.auth.fetch(
      new Request(`${config.issuer}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body
          ? {
              body:
                body instanceof URLSearchParams
                  ? body.toString()
                  : JSON.stringify(body),
            }
          : {}),
      }),
    );
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0] ?? "";
    return response;
  }
  async html(response: Response) {
    const html = await response.text();
    this.csrf =
      html.match(/(?:name|id)="csrf" value="([^"]+)"/)?.[1] ?? this.csrf;
    return html;
  }
  async login(authenticator: SoftwareAuthenticator, authorize: string) {
    assert.equal((await this.request(authorize)).status, 200);
    await this.html(await this.request(authorize));
    const login = await this.request(
      "/auth/login",
      new URLSearchParams({ csrf: this.csrf, password }),
    );
    assert.equal(login.status, 200);
    await this.html(login);
    const options = await (
      await this.request("/auth/passkey/options", { csrf: this.csrf })
    ).json();
    const response =
      options.ceremony === "register"
        ? authenticator.registration(options.options.challenge, config.issuer)
        : authenticator.authentication(
            options.options.challenge,
            config.issuer,
          );
    const verify = await this.request("/auth/passkey/verify", {
      csrf: this.csrf,
      response,
    });
    assert.equal(verify.status, 200);
    return this.html(verify);
  }
}
async function register(auth: AuthorizationServer) {
  const fetchFn: typeof fetch = async (input, init) =>
    auth.fetch(new Request(input, init));
  const metadata = await discoverOAuthMetadata(config.issuer, {}, fetchFn);
  assert.ok(metadata);
  const client = await registerClient(config.issuer, {
    metadata,
    clientMetadata: {
      client_name: "Fictional <worker>",
      redirect_uris: ["http://127.0.0.1:4567/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    },
    fetchFn,
  });
  return client.client_id;
}

function authorization(
  client: string,
  verifier: string,
  overrides: Record<string, string> = {},
) {
  return (
    "/oauth/authorize?" +
    new URLSearchParams({
      client_id: client,
      redirect_uri: "http://127.0.0.1:4567/callback",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: digest(verifier),
      resource,
      scope: "context:read context:write personal garden offline_access",
      state: "fictional-state",
      ...overrides,
    })
  );
}
async function post(
  auth: AuthorizationServer,
  path: string,
  data: Record<string, string>,
) {
  return auth.fetch(
    new Request(config.issuer + path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data),
    }),
  );
}

test("owner enrolls a passkey; DCR → PKCE → consent → SDK MCP save/read → refresh → replay → revoke", async () => {
  const store = new AuthStore(":memory:", config.areas),
    sources = new SourceStore(":memory:");
  const auth = new AuthorizationServer(store, config),
    browser = new Browser(auth),
    authenticator = new SoftwareAuthenticator();
  const mcp = createContextMcp(sources, [], true, { auth: store });
  const handler = protectMcp(mcp, config, store);
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "fictional-oauth-sdk", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return client;
  };
  try {
    await store.initOwner(password);
    const clientId = await register(auth),
      verifier = secret();
    const html = await browser.login(
      authenticator,
      authorization(clientId, verifier),
    );
    assert.match(html, /Fictional &lt;worker&gt;/);
    assert.match(html, /<option value="personal" selected>/);
    const consent = new URLSearchParams({
      csrf: browser.csrf,
      read: "garden",
      write: "garden",
      default_write: "garden",
      offline: "yes",
      decision: "allow",
    });
    const allowed = await browser.request("/oauth/consent", consent);
    assert.equal(allowed.status, 303);
    const callback = new URL(allowed.headers.get("location") ?? "");
    assert.equal(callback.searchParams.get("state"), "fictional-state");
    assert.equal(callback.searchParams.get("iss"), config.issuer);
    const data = {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:4567/callback",
      code_verifier: verifier,
      resource,
    };
    assert.equal(
      (
        await post(auth, "/oauth/token", {
          ...data,
          resource: "https://elsewhere.example/mcp",
        })
      ).status,
      400,
    );
    assert.equal(
      (await post(auth, "/oauth/token", { ...data, code_verifier: secret() }))
        .status,
      400,
    );
    const fetchFn: typeof fetch = async (input, init) =>
      auth.fetch(new Request(input, init));
    const metadata = await discoverOAuthMetadata(config.issuer, {}, fetchFn);
    assert.ok(metadata);
    const clientInformation = {
      client_id: clientId,
      token_endpoint_auth_method: "none" as const,
    };
    const tokens = await exchangeAuthorization(config.issuer, {
      metadata,
      clientInformation,
      authorizationCode: data.code,
      iss: callback.searchParams.get("iss") ?? "",
      codeVerifier: verifier,
      redirectUri: data.redirect_uri,
      resource,
      fetchFn,
    });
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.expires_in, 300);
    assert.equal(tokens.scope?.includes("personal"), false);
    const client = await connect(tokens.access_token);
    const saved = await client.callTool({
      name: "remember",
      arguments: {
        text: "Fictional violet garden lamp",
        idempotencyKey: "oauth-save",
      },
    });
    assert.ok(!saved.isError);
    assert.match(JSON.stringify(saved.structuredContent), /"scope":"garden"/);
    assert.ok(
      !(
        await client.callTool({
          name: "memory_context",
          arguments: { scope: "garden" },
        })
      ).isError,
    );
    assert.equal(
      (
        await client.callTool({
          name: "memory_context",
          arguments: { scope: "personal" },
        })
      ).isError,
      true,
    );
    const rotated = await refreshAuthorization(config.issuer, {
      metadata,
      clientInformation,
      refreshToken: tokens.refresh_token,
      resource,
      fetchFn,
    });
    assert.ok(rotated.refresh_token);
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    const reopened = await connect(rotated.access_token);
    assert.match(
      JSON.stringify(
        await reopened.callTool({
          name: "memory_context",
          arguments: { scope: "garden" },
        }),
      ),
      /violet garden lamp/,
    );
    assert.equal(
      (
        await post(auth, "/oauth/token", {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: tokens.refresh_token,
          resource,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await handler.fetch(
          new Request(resource, {
            headers: { authorization: `Bearer ${rotated.access_token}` },
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await post(auth, "/oauth/token", {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: rotated.refresh_token,
          resource,
        })
      ).status,
      400,
    );
    // A fresh login now requires the enrolled passkey and a new consent.
    const nextVerifier = secret();
    await browser.login(authenticator, authorization(clientId, nextVerifier));
    consent.set("csrf", browser.csrf);
    const next = await browser.request("/oauth/consent", consent);
    const nextCode =
      new URL(next.headers.get("location") ?? "").searchParams.get("code") ??
      "";
    const second = await (
      await post(auth, "/oauth/token", {
        ...data,
        code: nextCode,
        code_verifier: nextVerifier,
      })
    ).json();
    assert.equal(
      (
        await post(auth, "/oauth/revoke", {
          token: second.refresh_token,
          client_id: clientId,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await handler.fetch(
          new Request(resource, {
            headers: { authorization: `Bearer ${second.access_token}` },
          }),
        )
      ).status,
      401,
    );
  } finally {
    for (const client of clients) await client.close();
    await mcp.close();
    sources.close();
    store.close();
  }
});

test("authorization rejects redirect, PKCE, resource, duplicate and scope tampering before login", async () => {
  const store = new AuthStore(":memory:", config.areas),
    auth = new AuthorizationServer(store, config);
  try {
    const id = await register(auth),
      verifier = secret();
    for (const changes of [
      { redirect_uri: "http://127.0.0.1:4567/other" },
      { code_challenge_method: "plain" },
      { code_challenge: "bad" },
      { response_type: "token" },
      { resource: "https://foreign.example/mcp" },
      { scope: "context:write unknown" },
    ]) {
      const response = await auth.fetch(
        new Request(config.issuer + authorization(id, verifier, changes)),
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
    }
    assert.equal(
      (
        await auth.fetch(
          new Request(
            `${config.issuer + authorization(id, verifier)}&client_id=other`,
          ),
        )
      ).status,
      400,
    );
    for (const redirect of [
      "http://public.example/callback",
      "https://client.example/cb#fragment",
      "https://user:password@client.example/cb",
      "javascript:alert(1)",
      "http://localhost:3000/cb",
    ]) {
      const response = await auth.fetch(
        new Request(`${config.issuer}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: [redirect] }),
        }),
      );
      assert.equal(response.status, 400);
    }
  } finally {
    store.close();
  }
});

test("owner forms require CSRF and exact origin; password alone cannot consent; passkeys bind challenge, origin and user verification", async () => {
  const store = new AuthStore(":memory:", config.areas),
    auth = new AuthorizationServer(store, config),
    browser = new Browser(auth),
    key = new SoftwareAuthenticator();
  try {
    await store.initOwner(password);
    const id = await register(auth);
    const login = await browser.request(authorization(id, secret()));
    assert.match(
      login.headers.get("set-cookie") ?? "",
      /HttpOnly; Secure; SameSite=Lax/,
    );
    await browser.html(login);
    assert.equal(
      (
        await browser.request(
          "/auth/login",
          new URLSearchParams({ csrf: "wrong", password }),
        )
      ).status,
      403,
    );
    const foreign = await auth.fetch(
      new Request(`${config.issuer}/auth/login`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          cookie: browser.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: browser.csrf, password }),
      }),
    );
    assert.equal(foreign.status, 403);
    assert.equal(
      (
        await browser.request(
          "/auth/login",
          new URLSearchParams({ csrf: browser.csrf, password: "wrong" }),
        )
      ).status,
      401,
    );
    const oldCookie = browser.cookie;
    await browser.html(
      await browser.request(
        "/auth/login",
        new URLSearchParams({ csrf: browser.csrf, password }),
      ),
    );
    assert.notEqual(browser.cookie, oldCookie);
    assert.equal(
      (
        await browser.request(
          "/oauth/consent",
          new URLSearchParams({ csrf: browser.csrf, decision: "allow" }),
        )
      ).status,
      403,
    );
    for (const mode of ["origin", "challenge", "uv", "valid"]) {
      const options = await (
        await browser.request("/auth/passkey/options", { csrf: browser.csrf })
      ).json();
      const response = key.registration(
        mode === "challenge" ? "wrong" : options.options.challenge,
        mode === "origin" ? "https://foreign.example" : config.issuer,
        mode !== "uv",
      );
      const verified = await browser.request("/auth/passkey/verify", {
        csrf: browser.csrf,
        response,
      });
      assert.equal(verified.status === 200, mode === "valid");
      assert.notEqual(
        (
          await browser.request("/auth/passkey/verify", {
            csrf: browser.csrf,
            response,
          })
        ).status,
        200,
      );
    }
    const invalid = await browser.request(
      "/oauth/consent",
      new URLSearchParams({
        csrf: browser.csrf,
        decision: "allow",
        write: "unknown",
        default_write: "unknown",
      }),
    );
    assert.equal(invalid.status, 400);
    const denied = await browser.request(
      "/oauth/consent",
      new URLSearchParams({ csrf: browser.csrf, decision: "deny" }),
    );
    assert.equal(denied.status, 303);
    assert.equal(
      new URL(denied.headers.get("location") ?? "").searchParams.get("error"),
      "access_denied",
    );
    // Login with an existing key: invalid signatures cannot complete authentication.
    await browser.html(await browser.request(authorization(id, secret())));
    await browser.html(
      await browser.request(
        "/auth/login",
        new URLSearchParams({ csrf: browser.csrf, password }),
      ),
    );
    const options = await (
      await browser.request("/auth/passkey/options", { csrf: browser.csrf })
    ).json();
    const response = key.authentication(
      options.options.challenge,
      config.issuer,
    );
    response.response.signature = secret();
    assert.notEqual(
      (
        await browser.request("/auth/passkey/verify", {
          csrf: browser.csrf,
          response,
        })
      ).status,
      200,
    );
  } finally {
    store.close();
  }
});

test("access and refresh expiry are bounded; rotation cannot extend offline consent; client revocation invalidates all credentials", async () => {
  let now = 1000000;
  const store = new AuthStore(":memory:", config.areas, () => now),
    auth = new AuthorizationServer(store, config),
    browser = new Browser(auth),
    key = new SoftwareAuthenticator();
  try {
    await store.initOwner(password);
    const id = await register(auth),
      verifier = secret();
    await browser.login(key, authorization(id, verifier));
    const consent = await browser.request(
      "/oauth/consent",
      new URLSearchParams({
        csrf: browser.csrf,
        read: "garden",
        decision: "allow",
        offline: "yes",
      }),
    );
    const data = {
      grant_type: "authorization_code",
      code:
        new URL(consent.headers.get("location") ?? "").searchParams.get(
          "code",
        ) ?? "",
      client_id: id,
      redirect_uri: "http://127.0.0.1:4567/callback",
      resource,
      code_verifier: verifier,
    };
    const tokens = await (await post(auth, "/oauth/token", data)).json();
    now += 301;
    assert.throws(() => store.access(tokens.access_token, resource));
    // Offline access must survive more than a day of inactivity.
    now += 2 * 86400;
    const refresh = await post(auth, "/oauth/token", {
      grant_type: "refresh_token",
      client_id: id,
      resource,
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refresh.status, 200);
    const rotated = await refresh.json();
    assert.ok(store.access(rotated.access_token, resource));
    now = 1000000 + config.offlineSeconds + 1;
    assert.equal(
      (
        await post(auth, "/oauth/token", {
          grant_type: "refresh_token",
          client_id: id,
          resource,
          refresh_token: rotated.refresh_token,
        })
      ).status,
      400,
    );
    const cli = store.createCliToken(
      "fictional-agent",
      { read: ["garden"], write: [], process: [] },
      null,
      86400,
      resource,
    );
    store.revokeClient(cli.record.clientId);
    assert.throws(() => store.access(cli.token, resource));
  } finally {
    store.close();
  }
});

test("code reuse and concurrent refresh revoke the whole token family without affecting another client", async () => {
  const store = new AuthStore(":memory:", config.areas),
    auth = new AuthorizationServer(store, config),
    browser = new Browser(auth),
    key = new SoftwareAuthenticator();
  try {
    await store.initOwner(password);
    const id = await register(auth),
      verifier = secret();
    await browser.login(key, authorization(id, verifier));
    const consent = await browser.request(
      "/oauth/consent",
      new URLSearchParams({
        csrf: browser.csrf,
        read: "garden",
        decision: "allow",
      }),
    );
    const data = {
      grant_type: "authorization_code",
      code:
        new URL(consent.headers.get("location") ?? "").searchParams.get(
          "code",
        ) ?? "",
      client_id: id,
      redirect_uri: "http://127.0.0.1:4567/callback",
      resource,
      code_verifier: verifier,
    };
    const tokens = await (await post(auth, "/oauth/token", data)).json();
    assert.equal(
      (
        await post(auth, "/oauth/token", {
          grant_type: "refresh_token",
          client_id: "another-client",
          resource,
          refresh_token: tokens.refresh_token,
        })
      ).status,
      400,
    );
    assert.ok(store.access(tokens.access_token, resource));
    const replies = await Promise.all(
      [1, 2].map(() =>
        post(auth, "/oauth/token", {
          grant_type: "refresh_token",
          client_id: id,
          resource,
          refresh_token: tokens.refresh_token,
        }),
      ),
    );
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 400]);
    const rotated = await replies.find((r) => r.status === 200)?.json();
    assert.throws(() => store.access(rotated.access_token, resource));
    assert.equal((await post(auth, "/oauth/token", data)).status, 400);
  } finally {
    store.close();
  }
});

test("login and token endpoints bound requests with retry guidance", async () => {
  const store = new AuthStore(":memory:", config.areas),
    auth = new AuthorizationServer(store, config);
  try {
    for (let i = 0; i < 10; i++) await post(auth, "/auth/login", {});
    const login = await post(auth, "/auth/login", {});
    assert.equal(login.status, 429);
    assert.equal(login.headers.get("retry-after"), "60");
    for (let i = 0; i < 120; i++) await post(auth, "/oauth/token", {});
    assert.equal((await post(auth, "/oauth/token", {})).status, 429);
  } finally {
    store.close();
  }
});

test("owner passkey, refresh lineage and narrowed consent survive reopen and private backup/restore without plaintext credentials", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { backupDatabase, restoreDatabase } = await import("../src/backup.js");
  const directory = await mkdtemp(
      join(process.cwd(), ".output-auth-recovery-"),
    ),
    path = join(directory, "context.db"),
    snapshot = join(directory, "snapshot.db"),
    restored = join(directory, "restored.db");
  const sources = new SourceStore(path);
  sources.close();
  let store = new AuthStore(path, config.areas),
    auth = new AuthorizationServer(store, config);
  const key = new SoftwareAuthenticator(),
    browser = new Browser(auth);
  try {
    await store.initOwner(password);
    const id = await register(auth),
      verifier = secret();
    await browser.login(key, authorization(id, verifier));
    const allowed = await browser.request(
      "/oauth/consent",
      new URLSearchParams({
        csrf: browser.csrf,
        read: "garden",
        decision: "allow",
        offline: "yes",
      }),
    );
    const tokens = await (
      await post(auth, "/oauth/token", {
        grant_type: "authorization_code",
        client_id: id,
        code:
          new URL(allowed.headers.get("location") ?? "").searchParams.get(
            "code",
          ) ?? "",
        resource,
        redirect_uri: "http://127.0.0.1:4567/callback",
        code_verifier: verifier,
      })
    ).json();
    store.close();
    store = new AuthStore(path, config.areas);
    auth = new AuthorizationServer(store, config);
    assert.deepEqual(store.access(tokens.access_token, resource).grants, {
      read: ["garden"],
      write: [],
      process: [],
    });
    const rotated = await (
      await post(auth, "/oauth/token", {
        grant_type: "refresh_token",
        client_id: id,
        resource,
        refresh_token: tokens.refresh_token,
      })
    ).json();
    assert.ok(rotated.refresh_token);
    await backupDatabase(path, snapshot);
    await restoreDatabase(snapshot, restored);
    const bytes = await readFile(snapshot);
    for (const value of [
      password,
      tokens.access_token,
      tokens.refresh_token,
      rotated.refresh_token,
    ])
      assert.equal(bytes.includes(Buffer.from(value)), false);
    const restoredStore = new AuthStore(restored, config.areas),
      restoredAuth = new AuthorizationServer(restoredStore, config);
    try {
      await new Browser(restoredAuth).login(key, authorization(id, secret()));
      assert.equal(
        (
          await post(restoredAuth, "/oauth/token", {
            grant_type: "refresh_token",
            client_id: id,
            resource,
            refresh_token: tokens.refresh_token,
          })
        ).status,
        400,
      );
      assert.throws(() => restoredStore.access(rotated.access_token, resource));
    } finally {
      restoredStore.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
