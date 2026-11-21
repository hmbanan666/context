import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import type { KnowledgeItem } from "./knowledge.js";
import { copyLinkedAssociations, isLinkedToProject } from "./projects.js";
import { latestReviewStatusSql } from "./review-status.js";

// A client statement is one fact or decision written on remember, not by the
// processor. Profile writes are recorded so distillation leaves them alone.
export class ClientKnowledgeError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "forbidden" = "invalid_input",
  ) {
    super(message);
    this.name = "ClientKnowledgeError";
  }
}

export const statementLimit = 400;

export function installClientWrites(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_writes (
      source_id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('profile'))
    ) STRICT;
  `);
}

const offsetInstant = z.iso.datetime({ offset: true });
const storedInstant = z.iso.datetime();
const itemId = z.string().min(1).max(128);

/** Source authored time, otherwise capture time, stored in UTC with a Z suffix. */
export function statementCreatedAt(
  createdAt: string | undefined,
  capturedAt: string,
): string {
  const parsed = offsetInstant.safeParse(createdAt ?? capturedAt);
  if (!parsed.success) throw new ClientKnowledgeError("Invalid source time");
  if (/[zZ]$/u.test(parsed.data)) return parsed.data;
  const utc = new Date(parsed.data).toISOString();
  if (!storedInstant.safeParse(utc).success)
    throw new ClientKnowledgeError("Invalid source time");
  return utc;
}

export function assertStatementText(text: string): void {
  if (text.length > statementLimit || /[\r\n]/u.test(text))
    throw new ClientKnowledgeError(
      "A fact or decision is one statement of at most 400 characters",
    );
}

export interface ClientStatement {
  readonly kind: "fact" | "decision";
  readonly approve: boolean;
  readonly setBy: string;
  readonly tokenId?: string;
  readonly supersedes: readonly string[];
}

export interface ClientProfileWrite {
  readonly projectId: string;
  readonly purpose: string;
  readonly rules: string;
  readonly pinned: readonly string[];
  readonly setBy: string;
}

const actorSchema = z.string().trim().min(1).max(128);

export function writeClientStatement(
  db: DatabaseSync,
  input: ClientStatement & {
    readonly sourceId: string;
    readonly scope: string;
    readonly text: string;
    readonly createdAt: string;
    readonly projectIds: readonly string[];
  },
): KnowledgeItem {
  assertStatementText(input.text);
  const setBy = actorSchema.parse(input.setBy);
  const supersedes = [
    ...new Set(input.supersedes.map((id) => itemId.parse(id))),
  ];
  if (supersedes.length > 8)
    throw new ClientKnowledgeError("Pass at most 8 superseded items");
  const scope = scopeSchema.parse(input.scope);
  for (const id of supersedes) {
    const row = db
      .prepare("SELECT scope, kind FROM knowledge_items WHERE id = ?")
      .get(id) as { scope?: unknown; kind?: unknown } | undefined;
    if (
      !row ||
      row.scope !== scope ||
      (row.kind !== "fact" && row.kind !== "decision")
    )
      throw new ClientKnowledgeError(
        `Superseded item is not a fact or decision in this area: ${id}`,
      );
    for (const projectId of input.projectIds)
      if (!isLinkedToProject(db, "knowledge", id, projectId))
        throw new ClientKnowledgeError(
          `Superseded item is not in this project: ${id}`,
        );
  }
  const id = randomUUID();
  const createdAt = input.createdAt;
  const creator = { kind: "user" as const, name: setBy, version: "client-v1" };
  const sourceRefs = [{ sourceId: input.sourceId }];
  db.prepare(
    `INSERT INTO knowledge_items
      (id, scope, kind, text, source_refs, creator, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    scope,
    input.kind,
    input.text,
    JSON.stringify(sourceRefs),
    JSON.stringify(creator),
    createdAt,
  );
  copyLinkedAssociations(db, "source", input.sourceId, "knowledge", id);
  if (input.approve)
    db.prepare(
      `INSERT INTO knowledge_reviews (
        id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at
      ) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?)`,
    ).run(
      randomUUID(),
      id,
      scope,
      JSON.stringify({
        setBy,
        ...(input.tokenId ? { tokenId: input.tokenId } : {}),
      }),
      setBy,
      createdAt,
    );
  const link = db.prepare(
    `INSERT INTO knowledge_relations
      (id, scope, kind, from_id, to_id, source_refs, creator, created_at)
     VALUES (?, ?, 'supersedes', ?, ?, ?, ?, ?)`,
  );
  for (const target of supersedes)
    link.run(
      randomUUID(),
      scope,
      id,
      target,
      JSON.stringify(sourceRefs),
      JSON.stringify({ kind: "user", name: setBy }),
      createdAt,
    );
  return {
    id,
    scope,
    kind: input.kind,
    text: input.text,
    sourceRefs,
    creator,
    createdAt,
    status: input.approve ? "approved" : "proposed",
  };
}

export function findClientStatement(
  db: DatabaseSync,
  sourceId: string,
  scope: string,
): KnowledgeItem | undefined {
  const row = db
    .prepare(
      `SELECT k.id, k.scope, k.kind, k.text,
         k.source_refs AS sourceRefs, k.creator, k.created_at AS createdAt,
         ${latestReviewStatusSql("k.id", "k.scope", "proposed")} AS status
       FROM knowledge_items k, json_each(k.source_refs) ref
       WHERE k.scope = ?
         AND k.kind IN ('fact', 'decision')
         AND json_extract(k.creator, '$.version') = 'client-v1'
         AND json_extract(ref.value, '$.sourceId') = ?
       LIMIT 1`,
    )
    .get(scope, sourceId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const creator = z
    .object({
      kind: z.enum(["user", "model"]),
      name: z.string(),
      version: z.string().optional(),
    })
    .parse(JSON.parse(String(row.creator)));
  const sourceRefs = z
    .array(z.object({ sourceId: z.string(), quote: z.string().optional() }))
    .parse(JSON.parse(String(row.sourceRefs)));
  const kind = row.kind === "decision" ? "decision" : "fact";
  const status = row.status === "approved" ? "approved" : "proposed";
  return {
    id: String(row.id),
    scope: String(row.scope),
    kind,
    text: String(row.text),
    sourceRefs,
    creator,
    createdAt: String(row.createdAt),
    status,
  };
}

export function noteProfileSource(db: DatabaseSync, sourceId: string): void {
  installClientWrites(db);
  db.prepare(
    "INSERT INTO client_writes (source_id, kind) VALUES (?, 'profile')",
  ).run(sourceId);
}
