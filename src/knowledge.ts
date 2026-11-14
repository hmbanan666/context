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
import {
  knowledgeWindowSql,
  readJournalCitations,
  refreshProjectJournals,
  type JournalCitations,
  type JournalRefresh,
} from "./journal.js";
import {
  copyLinkedAssociations,
  installProjects,
  linkedProjectSql,
  projectIdSchema,
  projectNameSchema,
  proposeProjectLink,
} from "./projects.js";
import {
  decideProposals,
  listOpenProposals,
  type DecideProposalsInput,
  type OpenProposal,
  type ReviewDecision,
  type ReviewListInput,
} from "./review.js";
import { latestReviewStatusSql } from "./review-status.js";
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
export const storedKindSchema = z.enum([
  "idea",
  "observation",
  "decision_proposal",
  "fact",
  "decision",
  "journal",
]);
const knowledgeKindCheck =
  "'idea', 'observation', 'decision_proposal', 'fact', 'decision', 'journal'";
export type StoredKnowledgeKind = z.infer<typeof storedKindSchema>;
export type AddKnowledgeInput = z.infer<typeof addKnowledgeSchema>;
export type RelateKnowledgeInput = z.infer<typeof relateKnowledgeSchema>;
type KnowledgeStatus =
  | "suggested"
  | "proposed"
  | "reviewed"
  | "rejected"
  | "approved";
export interface KnowledgeItem {
  readonly id: string;
  readonly scope: string;
  readonly kind: StoredKnowledgeKind;
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

// SQLite cannot alter a CHECK. Copy rows into a new table and keep the name so
// legacy foreign keys (reviews, work authorizations) still point at it.
function migrateKnowledgeKinds(db: DatabaseSync) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_items'")
    .get() as { sql?: unknown } | undefined;
  const sql = String(row?.sql ?? "");
  // Match the kind token. SQLite may reflow whitespace around the CHECK.
  // 'journal' is the newest kind, so a fact-era table still needs this copy.
  if (!sql || sql.includes("'journal'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS knowledge_items_fts_insert;
      DROP TRIGGER IF EXISTS knowledge_items_search_insert;
      DROP TRIGGER IF EXISTS knowledge_items_search_delete;
      DROP TABLE IF EXISTS knowledge_items_fts;
      CREATE TABLE knowledge_items_new (
        id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN (${knowledgeKindCheck})),
        text TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        creator TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO knowledge_items_new (
        rowid, id, scope, kind, text, source_refs, creator, created_at
      )
      SELECT rowid, id, scope, kind, text, source_refs, creator, created_at
      FROM knowledge_items;
      DROP TABLE knowledge_items;
      ALTER TABLE knowledge_items_new RENAME TO knowledge_items;
      CREATE INDEX knowledge_items_scope ON knowledge_items(scope, created_at, id);
      CREATE VIRTUAL TABLE knowledge_items_fts USING fts5(
        text, content='knowledge_items', content_rowid='rowid'
      );
      CREATE TRIGGER knowledge_items_fts_insert AFTER INSERT ON knowledge_items BEGIN
        INSERT INTO knowledge_items_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      INSERT INTO knowledge_items_fts(knowledge_items_fts) VALUES ('rebuild');
    `);
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'knowledge_items_stemmed'",
        )
        .get()
    ) {
      db.exec(`
        CREATE TRIGGER knowledge_items_search_insert AFTER INSERT ON knowledge_items BEGIN
          INSERT INTO knowledge_items_stemmed(rowid, text)
          VALUES (new.rowid, context_stem(new.text));
          INSERT OR IGNORE INTO embedding_jobs(kind, record_id, scope)
          VALUES ('knowledge_items', new.id, new.scope);
        END;
        CREATE TRIGGER knowledge_items_search_delete AFTER DELETE ON knowledge_items BEGIN
          DELETE FROM knowledge_items_stemmed WHERE rowid = old.rowid;
          DELETE FROM embedding_chunks
          WHERE kind = 'knowledge_items' AND record_id = old.id;
          DELETE FROM embedding_jobs
          WHERE kind = 'knowledge_items' AND record_id = old.id;
        END;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const itemSchema = z.strictObject({
  id: identifier,
  scope: scopeSchema,
  kind: storedKindSchema,
  text: text(8192),
  sourceRefs: knowledgeSourceRefsSchema,
  creator: knowledgeCreatorSchema,
  createdAt: z.iso.datetime(),
  status: z.enum(["suggested", "proposed", "reviewed", "rejected", "approved"]),
});
const distilledInputSchema = z
  .strictObject({
    scope: scopeSchema,
    sourceId: identifier,
    kind: z.enum(["fact", "decision"]),
    text: text(400),
    createdAt: z.iso.datetime(),
    proposedProjectId: projectIdSchema.optional(),
    suggestedProjectName: projectNameSchema.optional(),
  })
  .refine((input) => !/[\r\n]/u.test(input.text), {
    message: "A distilled item is one sentence",
  })
  .refine(
    (input) =>
      input.proposedProjectId === undefined ||
      input.suggestedProjectName === undefined,
    { message: "Propose a project id or a suggested name" },
  );
export type DistilledKnowledgeInput = z.infer<typeof distilledInputSchema>;
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
// Distilled facts and decisions are proposed until the owner reviews them.
// Historical rows without a review stay suggested. Project-proposal audits in
// knowledge_reviews are excluded from this status.
const itemSelection = `SELECT k.id, k.scope, k.kind, k.text,
  k.source_refs AS sourceRefs, k.creator, k.created_at AS createdAt,
  CASE WHEN k.kind IN ('fact', 'decision') THEN
    ${latestReviewStatusSql("k.id", "k.scope", "proposed")}
  ELSE
    ${latestReviewStatusSql("k.id", "k.scope", "suggested")}
  END AS status
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
      installProjects(this.#database);
      this.#database.exec(`
        BEGIN IMMEDIATE;
        -- Do not rename knowledge_items. Legacy foreign keys
        -- (knowledge_reviews, historical knowledge_relations, work_authorizations)
        -- store this table name. SQLite does not rewrite those references.
        CREATE TABLE IF NOT EXISTS knowledge_items (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN (${knowledgeKindCheck})),
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
        this.#database
          .exec(`CREATE VIRTUAL TABLE knowledge_items_fts USING fts5(text, content='knowledge_items', content_rowid='rowid');
          CREATE TRIGGER knowledge_items_fts_insert AFTER INSERT ON knowledge_items BEGIN
            INSERT INTO knowledge_items_fts(rowid,text) VALUES(new.rowid,new.text);
          END;
          INSERT INTO knowledge_items_fts(knowledge_items_fts) VALUES('rebuild');`);
      }
      this.#database.exec("COMMIT;");
      installSearchIndex(this.#database, "knowledge_items");
      migrateKnowledgeKinds(this.#database);
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

  // One proposed sentence for one source revision. Never approves or supersedes.
  addDistilled(input: DistilledKnowledgeInput): {
    item: KnowledgeItem;
    duplicate: boolean;
  } {
    const request = distilledInputSchema.parse(input);
    const idempotencyKey = `distill:${createHash("sha256").update(request.sourceId).digest("hex")}`;
    identifier.parse(idempotencyKey);
    const hash = fingerprint({
      scope: request.scope,
      sourceId: request.sourceId,
      kind: request.kind,
      text: request.text,
      createdAt: request.createdAt,
      proposedProjectId: request.proposedProjectId ?? null,
      suggestedProjectName: request.suggestedProjectName ?? null,
    });
    return this.#transaction(() => {
      const prior = this.#request(request.scope, idempotencyKey, "add", hash);
      if (prior) {
        const item = this.find(prior, request.scope);
        if (!item) throw new Error("Missing knowledge request result");
        return { item, duplicate: true };
      }
      this.#checkSources([{ sourceId: request.sourceId }], request.scope);
      const id = randomUUID();
      const creator = {
        kind: "model",
        name: "context-tidy",
        version: "distill-v1",
      };
      this.#database
        .prepare(
          `INSERT INTO knowledge_items(id, scope, kind, text, source_refs, creator, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          request.scope,
          request.kind,
          request.text,
          JSON.stringify([{ sourceId: request.sourceId }]),
          JSON.stringify(creator),
          request.createdAt,
        );
      this.#saveRequest(request.scope, idempotencyKey, "add", hash, id);
      copyLinkedAssociations(
        this.#database,
        "source",
        request.sourceId,
        "knowledge",
        id,
      );
      if (request.proposedProjectId)
        proposeProjectLink(this.#database, {
          recordKind: "knowledge",
          recordId: id,
          sourceId: request.sourceId,
          projectId: request.proposedProjectId,
        });
      if (request.suggestedProjectName)
        proposeProjectLink(this.#database, {
          recordKind: "knowledge",
          recordId: id,
          sourceId: request.sourceId,
          suggestedName: request.suggestedProjectName,
        });
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
    // Area-wide search keeps its mix and omits distilled sentences and journals.
    // A project filter includes them so project search can rank them first.
    const conditions = ["k.scope = ?", "status <> 'rejected'"];
    if (!input.projectId)
      conditions.push("k.kind NOT IN ('fact', 'decision', 'journal')");
    const params: (string | number)[] = [input.scope];
    const window = knowledgeWindowSql(
      this.#database,
      "k",
      input.from,
      input.until,
    );
    conditions.push(window.sql);
    params.push(...window.params);
    if (input.projectId) {
      conditions.push(linkedProjectSql("knowledge", "k.id"));
      params.push(input.projectId);
    }
    if (input.terms.length) {
      const matches = (kindSql: string) =>
        lexicalCandidates(
          this.#database,
          "knowledge_items",
          `${itemSelection.replace("SELECT k.id", "SELECT k.rowid,k.id")} WHERE ${[...conditions, kindSql].filter(Boolean).join(" AND ")}`,
          params,
          input.terms,
          input.limit,
          input.vectors,
        );
      const materialize = (
        ids: readonly string[],
        total: number,
        matchOffsets: Map<string, number>,
      ) => ({
        total,
        matchOffsets,
        items: ids.map((id) => {
          const item = this.find(id, input.scope);
          if (!item) throw new Error("Missing knowledge candidate");
          return item;
        }),
      });
      if (!input.projectId) {
        const found = matches("");
        return materialize(found.ids, found.total, found.matchOffsets);
      }
      // Journals, then decisions, then facts, ahead of other notes.
      // A project plus a date bound also keeps in-window rows that share no
      // terms with the query. Matches stay ahead of those rows.
      const journals = matches("k.kind = 'journal'");
      const decisions = matches("k.kind = 'decision'");
      const facts = matches("k.kind = 'fact'");
      const rest = matches("k.kind NOT IN ('fact', 'decision', 'journal')");
      const recall = input.from !== undefined || input.until !== undefined;
      const dated = (kindSql: string) => {
        const where = [...conditions, kindSql].filter(Boolean).join(" AND ");
        const total = Number(
          this.#database
            .prepare(`SELECT count(*) n FROM (${itemSelection} WHERE ${where})`)
            .get(...params)?.n,
        );
        const ids = (
          this.#database
            .prepare(
              `SELECT id FROM (${itemSelection} WHERE ${where}) ORDER BY createdAt DESC, id LIMIT ?`,
            )
            .all(...params, input.limit) as { id: string }[]
        ).map((row) => row.id);
        return { total, ids };
      };
      const prefer = (matched: readonly string[], extra: readonly string[]) => {
        const ids = [...matched];
        for (const id of extra) if (!ids.includes(id)) ids.push(id);
        return ids;
      };
      const journalWindow = recall ? dated("k.kind = 'journal'") : undefined;
      const decisionWindow = recall ? dated("k.kind = 'decision'") : undefined;
      const factWindow = recall ? dated("k.kind = 'fact'") : undefined;
      const ids = [
        ...prefer(journals.ids, journalWindow?.ids ?? []),
        ...prefer(decisions.ids, decisionWindow?.ids ?? []),
        ...prefer(facts.ids, factWindow?.ids ?? []),
      ];
      for (const id of rest.ids) if (!ids.includes(id)) ids.push(id);
      const matchOffsets = new Map(rest.matchOffsets);
      for (const group of [facts, decisions, journals]) {
        for (const [id, offset] of group.matchOffsets)
          matchOffsets.set(id, offset);
      }
      return materialize(
        ids.slice(0, input.limit),
        (journalWindow?.total ?? journals.total) +
          (decisionWindow?.total ?? decisions.total) +
          (factWindow?.total ?? facts.total) +
          rest.total,
        matchOffsets,
      );
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
        `${itemSelection} WHERE ${where} ORDER BY ${input.projectId ? "CASE WHEN k.kind = 'journal' THEN 0 WHEN k.kind = 'decision' THEN 1 WHEN k.kind = 'fact' THEN 2 ELSE 3 END, k.created_at DESC, k.id" : "k.created_at DESC, k.id"} LIMIT ?`,
      )
      .all(...params, input.limit)
      .map(decodeItem);
    return { total, items, matchOffsets: new Map<string, number>() };
  }

  // Facts and decisions linked to one project, newest first. Rejected rows
  // stay out. The caller ranks decisions; this order is the fact order.
  projectDistilled(
    scope: string,
    projectId: string,
  ): { items: KnowledgeItem[]; truncated: boolean } {
    scopeSchema.parse(scope);
    projectIdSchema.parse(projectId);
    const where = `k.scope = ? AND k.kind IN ('fact', 'decision') AND ${linkedProjectSql("knowledge", "k.id")} AND ${latestReviewStatusSql("k.id", "k.scope", "proposed")} <> 'rejected'`;
    const params = [scope, projectId];
    const total = Number(
      this.#database
        .prepare(`SELECT count(*) n FROM knowledge_items k WHERE ${where}`)
        .get(...params)?.n,
    );
    const items = this.#database
      .prepare(
        `${itemSelection} WHERE ${where} ORDER BY k.created_at DESC, k.id ASC LIMIT 100`,
      )
      .all(...params)
      .map(decodeItem);
    return { items, truncated: total > 100 };
  }

  retrievalRelations(scope: string) {
    return retrievalRelations(this.#database, scope);
  }

  refreshJournals(input: {
    areas: readonly string[];
    now: Date;
    timeZone: string;
    dryRun: boolean;
    backfillLimit?: number;
  }): JournalRefresh {
    return refreshProjectJournals(this.#database, input);
  }

  journalCitations(id: string): JournalCitations | undefined {
    return readJournalCitations(this.#database, id);
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

  listProposals(filter: ReviewListInput = {}): {
    proposals: OpenProposal[];
    truncated: boolean;
  } {
    return listOpenProposals(this.#database, filter);
  }

  decideProposals(input: DecideProposalsInput): {
    decisions: ReviewDecision[];
  } {
    return decideProposals(this.#database, input);
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
