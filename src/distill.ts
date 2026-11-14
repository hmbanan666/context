import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { nonblankText } from "./contracts.js";
import {
  type DistilledKnowledgeInput,
  type KnowledgeStore,
  KnowledgeValidationError,
} from "./knowledge.js";
import type { Llm } from "./llm.js";
import {
  hasProject,
  projectIdSchema,
  projectNameSchema,
  UnknownProject,
} from "./projects.js";
import { redactFields } from "./redaction.js";
import { IdempotencyConflict } from "./store.js";

// ADR 0011. Caps are maxima: nightly tidy uses the defaults, tests may lower them.
export const DISTILL_BATCH_MAX = 8;
export const DISTILL_CALL_MAX = 12;
export const DISTILL_BODY_LIMIT = 1500;
export const DISTILL_CREATOR = "context-tidy";
export const distillInstruction =
  'Distill each indexed source into one proposed sentence. Return a JSON array of {"index":number,"kind":"fact"|"decision","text":string,"project":string|null}. Each text is one sentence of at most 400 characters, states what was decided or shipped, and includes every id listed in projects. project is an existing project id that is not already linked, a suggested name for a new project, or null. Do not copy 80 or more contiguous characters from body. You cannot approve an item or write supersedes. Extra fields are ignored.';

export type DistillStatus =
  | "completed"
  | "capped"
  | "skipped_not_configured"
  | "skipped_unavailable";
export interface DistillResult {
  calls: number;
  distilled: number;
  rejected: number;
  capped: boolean;
  after: number | null;
  status: DistillStatus;
  becameUnavailable: boolean;
}
interface DistillSource {
  row: number;
  id: string;
  text: string;
  scope: string;
  date: string;
  title: string | null;
  url: string | null;
  kind: string | null;
}
const answerSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(["fact", "decision"]),
  text: z.string(),
  project: z.union([z.string(), z.null()]).optional(),
});

export function distillationCap(value: number | undefined, max: number) {
  const cap = value ?? max;
  if (!Number.isInteger(cap) || cap < 1 || cap > max)
    throw new Error("Invalid distillation cap");
  return cap;
}
export function sourceBody(text: string, title: string | null) {
  if (title && text.startsWith(`${title}\n\n`))
    return text.slice(title.length + 2);
  return text;
}
export function clipText(text: string, max: number) {
  let end = Math.min(text.length, max);
  if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? ""))
    end--;
  return text.slice(0, end);
}
export function copiesStoredBody(sentence: string, body: string) {
  if (sentence.length < 80 || body.length < 80) return false;
  for (let index = 0; index <= sentence.length - 80; index++) {
    if (body.includes(sentence.slice(index, index + 80))) return true;
  }
  return false;
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}
function pending(
  db: DatabaseSync,
  areas: readonly string[],
  after: number,
  limit: number,
): DistillSource[] {
  const marks = areas.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT s.rowid AS row, s.id, s.text, s.scope,
        COALESCE(m.created_at, s.captured_at) AS date,
        m.title AS title, m.source_uri AS url,
        COALESCE(
          (SELECT json_extract(i.provenance, '$.kind')
           FROM source_imports i WHERE i.source_id = s.id LIMIT 1),
          m.type
        ) AS kind
       FROM sources s
       LEFT JOIN source_metadata m ON m.source_id = s.id
       WHERE s.scope IN (${marks}) AND s.rowid > ?
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_items k, json_each(k.source_refs) ref
           WHERE k.kind IN ('fact', 'decision')
             AND json_extract(k.creator, '$.name') = ?
             AND json_extract(ref.value, '$.sourceId') = s.id
         )
       ORDER BY s.rowid
       LIMIT ?`,
    )
    .all(...areas, after, DISTILL_CREATOR, limit)
    .map((row) => ({
      row: Number(row.row),
      id: String(row.id),
      text: String(row.text),
      scope: String(row.scope),
      date: String(row.date),
      title: textOrNull(row.title),
      url: textOrNull(row.url),
      kind: textOrNull(row.kind),
    }));
}
function linkedIds(db: DatabaseSync, sourceId: string) {
  return (
    db
      .prepare(
        `SELECT project_id AS id FROM project_associations
         WHERE record_kind = 'source' AND record_id = ?
           AND origin IN ('configured', 'client') AND status = 'linked'
         ORDER BY project_id`,
      )
      .all(sourceId) as { id: string }[]
  ).map((row) => row.id);
}
function proposalFor(
  db: DatabaseSync,
  raw: string | null | undefined,
  linked: readonly string[],
) {
  if (raw == null || !raw.trim()) return { ok: true as const };
  const value = raw.trim();
  const id = projectIdSchema.safeParse(value);
  if (id.success && hasProject(db, id.data)) {
    if (linked.includes(id.data)) return { ok: true as const };
    return { ok: true as const, proposedProjectId: id.data };
  }
  const name = projectNameSchema.safeParse(value);
  if (!name.success) return { ok: false as const };
  return { ok: true as const, suggestedProjectName: name.data };
}
function groupedAnswers(raw: unknown, count: number) {
  if (!Array.isArray(raw)) return undefined;
  const grouped = new Map<number, unknown[]>();
  for (const entry of raw) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("index" in entry) ||
      typeof entry.index !== "number"
    )
      continue;
    const list = grouped.get(entry.index) ?? [];
    list.push(entry);
    grouped.set(entry.index, list);
  }
  const answers = new Map<number, z.infer<typeof answerSchema>>();
  for (let index = 0; index < count; index++) {
    const entries = grouped.get(index) ?? [];
    const parsed = answerSchema.safeParse(
      entries.length === 1 ? entries[0] : undefined,
    );
    if (parsed.success) answers.set(index, parsed.data);
  }
  return answers;
}

export async function distillSources(input: {
  db: DatabaseSync;
  knowledge: KnowledgeStore;
  areas: readonly string[];
  dryRun: boolean;
  llm?: Llm;
  unavailable: boolean;
  batchSize: number;
  callCap: number;
  resumeAfter: number | null;
}): Promise<DistillResult> {
  const result: DistillResult = {
    calls: 0,
    distilled: 0,
    rejected: 0,
    capped: false,
    after: null,
    status: "completed",
    becameUnavailable: false,
  };
  if (!input.llm) {
    result.status = "skipped_not_configured";
    return result;
  }
  if (input.unavailable) {
    result.status = "skipped_unavailable";
    result.capped = input.resumeAfter != null;
    result.after = input.resumeAfter;
    return result;
  }
  let cursor = input.resumeAfter ?? 0;
  const sentence = nonblankText(400);
  while (result.calls < input.callCap) {
    const batch = pending(input.db, input.areas, cursor, input.batchSize);
    if (!batch.length) break;
    result.calls++;
    let raw: unknown;
    try {
      raw = await input.llm.ask(
        distillInstruction,
        redactFields(
          batch.map((source, index) => ({
            index,
            title: source.title,
            projects: linkedIds(input.db, source.id),
            url: source.url,
            date: source.date,
            kind: source.kind,
            body: clipText(
              sourceBody(source.text, source.title),
              DISTILL_BODY_LIMIT,
            ),
          })),
        ),
      );
    } catch {
      result.becameUnavailable = true;
      result.status = "skipped_unavailable";
      result.capped = cursor > 0;
      result.after = cursor > 0 ? cursor : null;
      return result;
    }
    const answers = groupedAnswers(raw, batch.length);
    for (const [index, source] of batch.entries()) {
      const answer = answers?.get(index);
      const projects = linkedIds(input.db, source.id);
      const text = answer?.text.trim() ?? "";
      const parsed = sentence.safeParse(text);
      const dated = z.iso.datetime().safeParse(source.date);
      const proposal = answer
        ? proposalFor(input.db, answer.project, projects)
        : { ok: false as const };
      const body = sourceBody(source.text, source.title);
      if (
        !answer ||
        !answers ||
        !parsed.success ||
        /[\r\n]/u.test(text) ||
        !dated.success ||
        !projects.every((id) => text.includes(id)) ||
        copiesStoredBody(text, body) ||
        !proposal.ok
      ) {
        result.rejected++;
        continue;
      }
      if (input.dryRun) {
        result.distilled++;
        continue;
      }
      const save: DistilledKnowledgeInput = {
        scope: source.scope,
        sourceId: source.id,
        kind: answer.kind,
        text,
        createdAt: dated.data,
        ...("proposedProjectId" in proposal
          ? { proposedProjectId: proposal.proposedProjectId }
          : {}),
        ...("suggestedProjectName" in proposal
          ? { suggestedProjectName: proposal.suggestedProjectName }
          : {}),
      };
      try {
        const saved = input.knowledge.addDistilled(save);
        if (!saved.duplicate) result.distilled++;
      } catch (error) {
        if (
          error instanceof z.ZodError ||
          error instanceof KnowledgeValidationError ||
          error instanceof IdempotencyConflict ||
          error instanceof UnknownProject
        ) {
          result.rejected++;
          continue;
        }
        throw error;
      }
    }
    cursor = batch.at(-1)?.row ?? cursor;
  }
  const more = pending(input.db, input.areas, cursor, 1);
  result.capped = more.length > 0;
  result.after = result.capped ? cursor : null;
  result.status = result.capped ? "capped" : "completed";
  return result;
}

export function relocateDistilledItems(
  db: DatabaseSync,
  sourceId: string,
  area: string,
) {
  const items = db
    .prepare(
      `SELECT id FROM knowledge_items
       WHERE scope = 'inbox'
         AND kind IN ('fact', 'decision')
         AND json_extract(creator, '$.name') = ?
         AND EXISTS (
           SELECT 1 FROM json_each(source_refs) ref
           WHERE json_extract(ref.value, '$.sourceId') = ?
         )`,
    )
    .all(DISTILL_CREATOR, sourceId) as { id: string }[];
  for (const item of items) {
    db.prepare(
      "UPDATE knowledge_items SET scope = ? WHERE id = ? AND scope = 'inbox'",
    ).run(area, item.id);
    db.prepare(
      "UPDATE embedding_chunks SET scope = ? WHERE kind = 'knowledge_items' AND record_id = ?",
    ).run(area, item.id);
    db.prepare(
      `UPDATE embedding_jobs
       SET scope = ?, status = 'queued', lease = NULL, attempts = 0, next_at = 0, error = NULL
       WHERE kind = 'knowledge_items' AND record_id = ?`,
    ).run(area, item.id);
    const request = db
      .prepare(
        `SELECT request_key, operation, fingerprint FROM knowledge_requests
         WHERE scope = 'inbox' AND record_id = ?`,
      )
      .get(item.id) as
      | { request_key: string; operation: string; fingerprint: string }
      | undefined;
    if (!request) continue;
    db.prepare(
      "DELETE FROM knowledge_requests WHERE scope = 'inbox' AND request_key = ?",
    ).run(request.request_key);
    db.prepare(
      `INSERT OR IGNORE INTO knowledge_requests
        (scope, request_key, operation, fingerprint, record_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      area,
      request.request_key,
      request.operation,
      request.fingerprint,
      item.id,
    );
  }
}
