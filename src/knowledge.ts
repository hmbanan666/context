import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import {
  ftsMatchOffset,
  ftsTerms,
  type PackageSelection,
} from "./package-query.js";
import { IdempotencyConflict } from "./store.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value),
    );

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
    kind: z.enum(["supports", "contradicts", "supersedes"]),
    fromId: identifier,
    toId: identifier,
    sourceRefs: knowledgeSourceRefsSchema,
    creator: knowledgeCreatorSchema,
  })
  .refine((input) => input.fromId !== input.toId, {
    message: "A relation needs two distinct items",
  });
export const reviewKnowledgeSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  id: identifier,
  idempotencyKey: identifier,
  status: z.enum(["reviewed", "rejected", "approved"]),
  evidence: text(1024),
});
const verifiedOwnerSchema = z.strictObject({
  kind: z.literal("verified-owner-signature"),
  subject: text(128),
  authenticated: z.literal(true),
  signature: z.string().length(88),
});

export type AddKnowledgeInput = z.infer<typeof addKnowledgeSchema>;
export type RelateKnowledgeInput = z.infer<typeof relateKnowledgeSchema>;
export type ReviewKnowledgeInput = z.infer<typeof reviewKnowledgeSchema>;
export type VerifiedKnowledgeOwner = z.infer<typeof verifiedOwnerSchema>;
type KnowledgeStatus = "suggested" | ReviewKnowledgeInput["status"];
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
export interface KnowledgeReview {
  readonly id: string;
  readonly knowledgeId: string;
  readonly scope: string;
  readonly status: ReviewKnowledgeInput["status"];
  readonly evidence: string;
  readonly reviewer: string;
  readonly createdAt: string;
  readonly signedReceipt: {
    readonly review: ReviewKnowledgeInput;
    readonly signature: string;
  };
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
  kind: z.enum(["supports", "contradicts", "supersedes"]),
  fromId: identifier,
  toId: identifier,
  sourceRefs: knowledgeSourceRefsSchema,
  creator: knowledgeCreatorSchema,
  createdAt: z.iso.datetime(),
  status: z.literal("suggested"),
});
const reviewSchema = z.strictObject({
  id: identifier,
  knowledgeId: identifier,
  scope: scopeSchema,
  status: reviewKnowledgeSchema.shape.status,
  evidence: text(1024),
  reviewer: text(128),
  createdAt: z.iso.datetime(),
  signedReceipt: z.strictObject({
    review: reviewKnowledgeSchema,
    signature: z.string().length(88),
  }),
});
const itemSelection = `SELECT k.id, k.scope, k.kind, k.text,
  k.source_refs AS sourceRefs, k.creator, k.created_at AS createdAt,
  COALESCE((SELECT r.status FROM knowledge_reviews r
    WHERE r.knowledge_id = k.id AND r.scope = k.scope ORDER BY r.rowid DESC LIMIT 1), 'suggested') AS status
  FROM knowledge_items k`;
const relationSelection = `SELECT id, scope, kind, from_id AS fromId, to_id AS toId,
  source_refs AS sourceRefs, creator, created_at AS createdAt, 'suggested' AS status FROM knowledge_relations`;
const reviewSelection = `SELECT id, knowledge_id AS knowledgeId, scope, status,
  evidence, reviewer, created_at AS createdAt, signed_receipt AS signedReceipt FROM knowledge_reviews`;

function decodeReview(row: Record<string, unknown>): KnowledgeReview {
  return reviewSchema.parse({
    ...row,
    signedReceipt: JSON.parse(String(row.signedReceipt)),
  });
}

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

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    try {
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
          kind TEXT NOT NULL CHECK(kind IN ('supports', 'contradicts', 'supersedes')),
          from_id TEXT NOT NULL REFERENCES knowledge_items(id),
          to_id TEXT NOT NULL REFERENCES knowledge_items(id),
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
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      this.#database.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
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
    const request = addKnowledgeSchema.parse(input);
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
    const match = input.terms.length > 0;
    if (match) {
      conditions.push("knowledge_items_fts MATCH ?");
      params.push(ftsTerms(input.terms));
    } else {
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(k.source_refs) ref WHERE json_extract(ref.value,'$.sourceId') IN (${sourceIds.map(() => "?").join(",")}))`,
      );
      params.push(...sourceIds);
    }
    const selection =
      itemSelection +
      (match
        ? " JOIN knowledge_items_fts ON knowledge_items_fts.rowid = k.rowid"
        : "");
    const where = conditions.join(" AND ");
    const total = Number(
      this.#database
        .prepare(`SELECT count(*) n FROM (${selection} WHERE ${where})`)
        .get(...params)?.n,
    );
    const matchOffsets = new Map<string, number>();
    const rankedSelection = match
      ? selection.replace(
          "SELECT ",
          "SELECT highlight(knowledge_items_fts,0,' ','') AS highlighted, ",
        )
      : selection;
    const items = this.#database
      .prepare(
        `${rankedSelection} WHERE ${where} ORDER BY ${match ? "knowledge_items_fts.rank," : ""} k.created_at DESC, k.id LIMIT ?`,
      )
      .all(...params, input.limit)
      .map(({ highlighted, ...row }) => {
        const item = decodeItem(row);
        matchOffsets.set(item.id, ftsMatchOffset(item.text, highlighted));
        return item;
      });
    return { total, items, matchOffsets };
  }

  packageRelations(scope: string, ids: readonly string[]) {
    if (!ids.length) return [];
    if (ids.length > 20) throw new Error("Too many relation seeds");
    const placeholders = ids.map(() => "?").join(",");
    return this.#database
      .prepare(
        `${relationSelection} WHERE scope=? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders})) ORDER BY created_at DESC,id LIMIT 51`,
      )
      .all(scope, ...ids, ...ids)
      .map(decodeRelation);
  }

  relate(input: RelateKnowledgeInput): {
    relation: KnowledgeRelation;
    duplicate: boolean;
  } {
    const request = relateKnowledgeSchema.parse(input);
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
        !this.find(request.fromId, request.scope) ||
        !this.find(request.toId, request.scope)
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

  // This is a trusted signature-verification boundary, never an MCP tool.
  // Evidence is an audit annotation; only the caller's verified owner context authorizes review.
  review(
    input: ReviewKnowledgeInput,
    verifiedOwner: VerifiedKnowledgeOwner,
  ): { item: KnowledgeItem; event: KnowledgeReview; duplicate: boolean } {
    const owner = verifiedOwnerSchema.parse(verifiedOwner);
    const request = reviewKnowledgeSchema.parse(input);
    const hash = fingerprint([request, owner.subject]);
    return this.#transaction(() => {
      const item = this.find(request.id, request.scope);
      if (!item) throw new KnowledgeNotFound("Knowledge unavailable");
      const prior = this.#request(
        request.scope,
        request.idempotencyKey,
        "review",
        hash,
      );
      if (prior) {
        const row = this.#database
          .prepare(`${reviewSelection} WHERE id = ? AND scope = ?`)
          .get(prior, request.scope);
        if (!row) throw new Error("Missing review request result");
        return { item, event: decodeReview(row), duplicate: true };
      }
      if (request.status === "approved" && item.kind !== "decision_proposal") {
        throw new KnowledgeValidationError(
          "Only decision proposals can be approved",
        );
      }
      const id = randomUUID();
      this.#database
        .prepare(`INSERT INTO knowledge_reviews(id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          request.id,
          request.scope,
          request.status,
          request.evidence,
          owner.subject,
          JSON.stringify({ review: request, signature: owner.signature }),
          new Date().toISOString(),
        );
      this.#saveRequest(
        request.scope,
        request.idempotencyKey,
        "review",
        hash,
        id,
      );
      const row = this.#database
        .prepare(`${reviewSelection} WHERE id = ? AND scope = ?`)
        .get(id, request.scope);
      const updated = this.find(request.id, request.scope);
      if (!row || !updated) throw new Error("Missing inserted review");
      return {
        item: updated,
        event: decodeReview(row),
        duplicate: false,
      };
    });
  }

  history(id: string, scope: string): KnowledgeReview[] {
    validateLookup(id, scope);
    return this.#database
      .prepare(
        `${reviewSelection} WHERE knowledge_id = ? AND scope = ? ORDER BY rowid`,
      )
      .all(id, scope)
      .map(decodeReview);
  }

  close(): void {
    this.#database.close();
  }
}
