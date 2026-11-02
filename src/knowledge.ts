import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  identifierSchema as identifier,
  scopeSchema,
  nonblankText as text,
} from "./contracts.js";
import type { PackageSelection } from "./package-query.js";
import { redactFields } from "./redaction.js";
import { retrievalRelations } from "./retrieval-relations.js";
import { installSearchIndex, lexicalCandidates } from "./search-lexical.js";
import { IdempotencyConflict } from "./store.js";

export const supersedesSchema = z
  .array(identifier)
  .min(1)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length);

export const knowledgeCreatorSchema = z.strictObject({
  kind: z.enum(["user", "model"]),
  name: text(128),
  version: text(128).optional(),
});
export const knowledgeSourceRefsSchema = z
  .array(
    z.strictObject({
      sourceId: identifier,
      quote: text(1024).optional(),
    }),
  )
  .min(1)
  .max(8)
  .refine(
    (refs) => new Set(refs.map((ref) => ref.sourceId)).size === refs.length,
  );

export const addKnowledgeSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  idempotencyKey: identifier,
  kind: z.enum(["idea", "observation", "decision_proposal"]),
  text: text(8192),
  sourceRefs: knowledgeSourceRefsSchema,
  creator: knowledgeCreatorSchema,
});
export const relateKnowledgeSchema = z
  .strictObject({
    version: z.literal(1),
    scope: scopeSchema,
    idempotencyKey: identifier,
    kind: z.enum(["supports", "contradicts", "supersedes", "duplicates"]),
    fromId: identifier,
    toId: identifier,
    sourceRefs: knowledgeSourceRefsSchema,
    creator: knowledgeCreatorSchema,
  })
  .refine((input) => input.fromId !== input.toId, {
    message: "A relation needs two distinct items",
  });
export type AddKnowledgeInput = z.infer<typeof addKnowledgeSchema>;
export type RelateKnowledgeInput = z.infer<typeof relateKnowledgeSchema>;
type KnowledgeStatus = "suggested" | "reviewed" | "rejected" | "approved";
export interface KnowledgeItem {
  readonly id: string;
  readonly scope: string;
  readonly kind: AddKnowledgeInput["kind"];
  readonly text: string;
  readonly sourceRefs: AddKnowledgeInput["sourceRefs"];
  readonly creator: AddKnowledgeInput["creator"];
  readonly createdAt: string;
  readonly status: KnowledgeStatus;
}
export interface KnowledgeRelation {
  readonly id: string;
  readonly scope: string;
  readonly kind: RelateKnowledgeInput["kind"];
  readonly fromId: string;
  readonly toId: string;
  readonly sourceRefs: AddKnowledgeInput["sourceRefs"];
  readonly creator: AddKnowledgeInput["creator"];
  readonly createdAt: string;
  readonly status: "suggested";
}
export class KnowledgeNotFound extends Error {}
export class KnowledgeValidationError extends Error {}

const itemSchema = z.strictObject({
  id: identifier,
  scope: scopeSchema,
  kind: addKnowledgeSchema.shape.kind,
  text: text(8192),
  sourceRefs: knowledgeSourceRefsSchema,
  creator: knowledgeCreatorSchema,
  createdAt: z.iso.datetime(),
  status: z.enum(["suggested", "reviewed", "rejected", "approved"]),
});
const relationSchema = z.strictObject({
  id: identifier,
  scope: scopeSchema,
  kind: z.enum(["supports", "contradicts", "supersedes", "duplicates"]),
  fromId: identifier,
  toId: identifier,
  sourceRefs: knowledgeSourceRefsSchema,
  creator: knowledgeCreatorSchema,
  createdAt: z.iso.datetime(),
  status: z.literal("suggested"),
});
// Preserve historical status without exposing review writes or receipts.
const itemSelection = `SELECT k.id, k.scope, k.kind, k.text,
  k.source_refs AS sourceRefs, k.creator, k.created_at AS createdAt,
  COALESCE((SELECT r.status FROM knowledge_reviews r
    WHERE r.knowledge_id = k.id AND r.scope = k.scope ORDER BY r.rowid DESC LIMIT 1), 'suggested') AS status
  FROM knowledge_items k`;
const relationSelection = `SELECT id, scope, kind, from_id AS fromId, to_id AS toId,
  source_refs AS sourceRefs, creator, created_at AS createdAt, 'suggested' AS status FROM knowledge_relations`;
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function decodeItem(row: Record<string, unknown>): KnowledgeItem {
  return itemSchema.parse({
    ...row,
    sourceRefs: JSON.parse(String(row.sourceRefs)),
    creator: JSON.parse(String(row.creator)),
  });
}
function decodeRelation(row: Record<string, unknown>): KnowledgeRelation {
  return relationSchema.parse({
    ...row,
    sourceRefs: JSON.parse(String(row.sourceRefs)),
    creator: JSON.parse(String(row.creator)),
  });
}
function validateLookup(id: string, scope: string): void {
  identifier.parse(id);
  scopeSchema.parse(scope);
}
function validateLimit(scope: string, limit: number): void {
  scopeSchema.parse(scope);
  z.number().int().min(1).max(100).parse(limit);
}

export class KnowledgeStore {
  readonly #database: DatabaseSync;
  readonly #ownsConnection: boolean;

  constructor(
    path: string | DatabaseSync,
    options: { readOnly?: boolean } = {},
  ) {
    this.#ownsConnection = typeof path === "string";
    this.#database =
      typeof path === "string"
        ? new DatabaseSync(path, {
            timeout: 5000,
            readOnly: options.readOnly ?? false,
          })
        : path;
    // Borrow an initialized writer connection to commit source and relations together.
    if (!this.#ownsConnection) return;
    try {
      if (!options.readOnly)
        this.#database.exec(
          "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;",
        );
      this.#database
        .prepare("SELECT id, text, scope FROM sources LIMIT 1")
        .get();
      this.#database.function(
        "source_timestamp",
        { deterministic: true },
        (value) =>
          typeof value === "string" && Number.isFinite(Date.parse(value))
            ? Date.parse(value)
            : null,
      );
      if (options.readOnly) return;
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS knowledge_items (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('idea', 'observation', 'decision_proposal')),
          text TEXT NOT NULL,
          source_refs TEXT NOT NULL,
          creator TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS knowledge_items_scope ON knowledge_items(scope, created_at, id);
        CREATE TABLE IF NOT EXISTS knowledge_relations (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('supports', 'contradicts', 'supersedes', 'duplicates')),
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          source_refs TEXT NOT NULL,
          creator TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK(from_id <> to_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS knowledge_relations_scope ON knowledge_relations(scope, created_at, id);
        CREATE TABLE IF NOT EXISTS knowledge_reviews (
          id TEXT PRIMARY KEY NOT NULL,
          knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id),
          scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('reviewed', 'rejected', 'approved')),
          evidence TEXT NOT NULL,
          reviewer TEXT NOT NULL,
          signed_receipt TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS knowledge_reviews_item ON knowledge_reviews(knowledge_id, scope);
        CREATE TABLE IF NOT EXISTS knowledge_requests (
          scope TEXT NOT NULL,
          request_key TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('add', 'relate', 'review')),
          fingerprint TEXT NOT NULL,
          record_id TEXT NOT NULL,
          PRIMARY KEY(scope, request_key)
        ) STRICT;
        COMMIT;
      `);
      // SQLite cannot alter CHECK/FK constraints; copy all historical rows atomically.
      const relationSql = String(
        this.#database
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name='knowledge_relations'",
          )
          .get()?.sql,
      );
      if (!relationSql.includes("'duplicates'")) {
        this.#database.exec(`BEGIN IMMEDIATE;
          ALTER TABLE knowledge_relations RENAME TO knowledge_relations_old;
          CREATE TABLE knowledge_relations (
            id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('supports','contradicts','supersedes','duplicates')),
            from_id TEXT NOT NULL, to_id TEXT NOT NULL, source_refs TEXT NOT NULL,
            creator TEXT NOT NULL, created_at TEXT NOT NULL, CHECK(from_id <> to_id)
          ) STRICT;
          INSERT INTO knowledge_relations SELECT * FROM knowledge_relations_old;
          DROP TABLE knowledge_relations_old;
          CREATE INDEX knowledge_relations_scope ON knowledge_relations(scope,created_at,id);
          COMMIT;`);
      }
      this.#database.exec(`
        CREATE INDEX IF NOT EXISTS knowledge_relations_from ON knowledge_relations(scope,from_id,kind);
        CREATE INDEX IF NOT EXISTS knowledge_relations_to ON knowledge_relations(scope,to_id,kind);
      `);
      this.#database.exec("BEGIN IMMEDIATE;");
      if (
        !this.#database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name = 'knowledge_items_fts'",
          )
          .get()
      ) {
        this.#database.exec(`CREATE VIRTUAL TABLE knowledge_items_fts USING fts5(text, content='knowledge_items', content_rowid='rowid');
          CREATE TRIGGER knowledge_items_fts_insert AFTER INSERT ON knowledge_items BEGIN
            INSERT INTO knowledge_items_fts(rowid,text) VALUES(new.rowid,new.text);
          END;
          INSERT INTO knowledge_items_fts(knowledge_items_fts) VALUES('rebuild');`);
      }
      this.#database.exec("COMMIT;");
      installSearchIndex(this.#database, "knowledge_items");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      this.#database.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    if (this.#database.isTransaction) return operation();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #checkSources(refs: AddKnowledgeInput["sourceRefs"], scope: string): void {
    for (const ref of refs) {
      const source = this.#database
        .prepare("SELECT text FROM sources WHERE id = ? AND scope = ?")
        .get(ref.sourceId, scope);
      if (!source) throw new KnowledgeNotFound("Source unavailable");
      if (ref.quote !== undefined && !String(source.text).includes(ref.quote)) {
        throw new KnowledgeValidationError("Quote is absent from source");
      }
    }
  }

  #request(
    scope: string,
    key: string,
    operation: string,
    hash: string,
  ): string | undefined {
    const prior = this.#database
      .prepare(
        "SELECT operation, fingerprint, record_id FROM knowledge_requests WHERE scope = ? AND request_key = ?",
      )
      .get(scope, key);
    if (!prior) return undefined;
    if (prior.operation !== operation || prior.fingerprint !== hash) {
      throw new IdempotencyConflict(
        "Idempotency key reused with different input",
      );
    }
    return String(prior.record_id);
  }

  #saveRequest(
    scope: string,
    key: string,
    operation: string,
    hash: string,
    id: string,
  ): void {
    this.#database
      .prepare(
        "INSERT INTO knowledge_requests(scope, request_key, operation, fingerprint, record_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(scope, key, operation, hash, id);
  }

  add(input: AddKnowledgeInput): { item: KnowledgeItem; duplicate: boolean } {
    const request = addKnowledgeSchema.parse(
      redactFields(addKnowledgeSchema.parse(input)),
    );
    const hash = fingerprint(request);
    return this.#transaction(() => {
      const prior = this.#request(
        request.scope,
        request.idempotencyKey,
        "add",
        hash,
      );
      if (prior) {
        const item = this.find(prior, request.scope);
        if (!item) throw new Error("Missing knowledge request result");
        return { item, duplicate: true };
      }
      this.#checkSources(request.sourceRefs, request.scope);
      const id = randomUUID();
      this.#database
        .prepare(`INSERT INTO knowledge_items(id, scope, kind, text, source_refs, creator, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          request.scope,
          request.kind,
          request.text,
          JSON.stringify(request.sourceRefs),
          JSON.stringify(request.creator),
          new Date().toISOString(),
        );
      this.#saveRequest(request.scope, request.idempotencyKey, "add", hash, id);
      const item = this.find(id, request.scope);
      if (!item) throw new Error("Missing inserted knowledge");
      return { item, duplicate: false };
    });
  }

  find(id: string, scope: string): KnowledgeItem | undefined {
    validateLookup(id, scope);
    const row = this.#database
      .prepare(`${itemSelection} WHERE k.id = ? AND k.scope = ?`)
      .get(id, scope);
    return row ? decodeItem(row) : undefined;
  }

  list(scope: string, limit = 20): KnowledgeItem[] {
    validateLimit(scope, limit);
    return this.#database
      .prepare(
        `${itemSelection} WHERE k.scope = ? ORDER BY k.created_at DESC, k.id LIMIT ?`,
      )
      .all(scope, limit)
      .map(decodeItem);
  }

  packageCandidates(input: PackageSelection, sourceIds: readonly string[]) {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 101 ||
      sourceIds.length > 100
    )
      throw new Error("Invalid candidate bound");
    if (!input.terms.length && !sourceIds.length)
      return { total: 0, items: [], matchOffsets: new Map<string, number>() };
    const conditions = ["k.scope = ?", "status <> 'rejected'"];
    const params: (string | number)[] = [input.scope];
    const invalid = ["s.id IS NULL"];
    const date = "source_timestamp(COALESCE(m.created_at,s.captured_at))";
    if (input.from) {
      invalid.push(`${date} < ?`);
      params.push(Date.parse(input.from));
    }
    if (input.until) {
      invalid.push(`${date} >= ?`);
      params.push(Date.parse(input.until));
    }
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM json_each(k.source_refs) ref LEFT JOIN sources s ON s.id=json_extract(ref.value,'$.sourceId') AND s.scope=k.scope LEFT JOIN source_metadata m ON m.source_id=s.id WHERE ${invalid.join(" OR ")})`,
    );
    if (input.terms.length) {
      const found = lexicalCandidates(
        this.#database,
        "knowledge_items",
        `${itemSelection.replace("SELECT k.id", "SELECT k.rowid,k.id")} WHERE ${conditions.join(" AND ")}`,
        params,
        input.terms,
        input.limit,
        input.vectors,
      );
      return {
        ...found,
        items: found.ids.map((id) => {
          const item = this.find(id, input.scope);
          if (!item) throw new Error("Missing knowledge candidate");
          return item;
        }),
      };
    }
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(k.source_refs) ref WHERE json_extract(ref.value,'$.sourceId') IN (${sourceIds.map(() => "?").join(",")}))`,
    );
    params.push(...sourceIds);
    const where = conditions.join(" AND ");
    const total = Number(
      this.#database
        .prepare(`SELECT count(*) n FROM (${itemSelection} WHERE ${where})`)
        .get(...params)?.n,
    );
    const items = this.#database
      .prepare(
        `${itemSelection} WHERE ${where} ORDER BY k.created_at DESC,k.id LIMIT ?`,
      )
      .all(...params, input.limit)
      .map(decodeItem);
    return { total, items, matchOffsets: new Map<string, number>() };
  }

  retrievalRelations(scope: string) {
    return retrievalRelations(this.#database, scope);
  }

  packageRelations(scope: string, ids: readonly string[]) {
    if (!ids.length) return [];
    if (ids.length > 40) throw new Error("Too many relation seeds");
    const placeholders = ids.map(() => "?").join(",");
    return this.#database
      .prepare(
        `${relationSelection} WHERE scope=? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders})) ORDER BY created_at DESC,id LIMIT 51`,
      )
      .all(scope, ...ids, ...ids)
      .map(decodeRelation);
  }

  hasEndpoint(id: string, scope: string) {
    validateLookup(id, scope);
    return !!(
      this.find(id, scope) ??
      this.#database
        .prepare("SELECT id FROM sources WHERE id=? AND scope=?")
        .get(id, scope)
    );
  }

  relate(input: RelateKnowledgeInput): {
    relation: KnowledgeRelation;
    duplicate: boolean;
  } {
    const request = relateKnowledgeSchema.parse(
      redactFields(relateKnowledgeSchema.parse(input)),
    );
    const hash = fingerprint(request);
    return this.#transaction(() => {
      const prior = this.#request(
        request.scope,
        request.idempotencyKey,
        "relate",
        hash,
      );
      if (prior) {
        const row = this.#database
          .prepare(`${relationSelection} WHERE id = ? AND scope = ?`)
          .get(prior, request.scope);
        if (!row) throw new Error("Missing relation request result");
        return { relation: decodeRelation(row), duplicate: true };
      }
      if (
        !this.hasEndpoint(request.fromId, request.scope) ||
        !this.hasEndpoint(request.toId, request.scope)
      ) {
        throw new KnowledgeNotFound("Knowledge unavailable");
      }
      this.#checkSources(request.sourceRefs, request.scope);
      const id = randomUUID();
      this.#database
        .prepare(`INSERT INTO knowledge_relations(id, scope, kind, from_id, to_id, source_refs, creator, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          request.scope,
          request.kind,
          request.fromId,
          request.toId,
          JSON.stringify(request.sourceRefs),
          JSON.stringify(request.creator),
          new Date().toISOString(),
        );
      this.#saveRequest(
        request.scope,
        request.idempotencyKey,
        "relate",
        hash,
        id,
      );
      const row = this.#database
        .prepare(`${relationSelection} WHERE id = ? AND scope = ?`)
        .get(id, request.scope);
      if (!row) throw new Error("Missing inserted relation");
      return { relation: decodeRelation(row), duplicate: false };
    });
  }

  relations(scope: string, limit = 20): KnowledgeRelation[] {
    validateLimit(scope, limit);
    return this.#database
      .prepare(
        `${relationSelection} WHERE scope = ? ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(scope, limit)
      .map(decodeRelation);
  }

  close(): void {
    if (this.#ownsConnection) this.#database.close();
  }
}
