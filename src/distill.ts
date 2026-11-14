import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { nonblankText } from "./contracts.js";
import {
  type DistilledKnowledgeInput,
  type KnowledgeStore,
  KnowledgeValidationError,
} from "./knowledge.js";
import type { Llm } from "./llm.js";
import { askLlm, LlmCallError } from "./llm-call.js";
import {
  hasProject,
  projectIdSchema,
  projectNameSchema,
  UnknownProject,
} from "./projects.js";
import { redact, redactFields } from "./redaction.js";
import { visibleSourceText } from "./source-text.js";
import { IdempotencyConflict } from "./store.js";

// ADR 0011. Caps are maxima: nightly tidy uses the defaults, tests may lower them.
export const DISTILL_BATCH_MAX = 8;
export const DISTILL_CALL_MAX = 12;
export const DISTILL_BODY_LIMIT = 1500;
export const DISTILL_CREATOR = "context-tidy";
export const DISTILL_UNLINKED = "*";
export const distillInstruction = [
  "Distill each indexed source into one proposed sentence.",
  'Return a JSON array of {"index":number,"kind":"fact"|"decision","text":string,"project":string|null}.',
  "Each text is one self-contained sentence of at most 400 characters.",
  "State what changed, and state why or the impact when the source says so.",
  "Keep product and project terms as the source writes them; do not replace them with generic words.",
  "Write in the dominant language of the source: a Russian source yields a Russian sentence.",
  "When projects lists ids, the item inherits those links and the sentence does not have to spell the id.",
  "When projects is empty and project is set, the sentence must name that project.",
  "project is an existing project id that is not already linked, a suggested name for a new project, or null.",
  "Do not copy 80 or more contiguous characters from body.",
  "You cannot approve an item, write supersedes, or write a project profile.",
  "Extra fields are ignored.",
].join(" ");

export type DistillStatus =
  | "completed"
  | "capped"
  | "skipped_not_configured"
  | "skipped_unavailable"
  | "skipped_backfill";
export interface DistillFrontier {
  readonly date: string;
  readonly row: number;
}
export type DistillFrontiers = Readonly<Record<string, DistillFrontier>>;
export const DISTILL_REJECTION_REASONS = [
  "parse-error",
  "empty",
  "too-long",
  "newline",
  "invalid-date",
  "missing-project",
  "copy-80",
  "invalid-project",
  "save-error",
] as const;
export type DistillRejectionReason = (typeof DISTILL_REJECTION_REASONS)[number];
export type DistillRejections = Record<DistillRejectionReason, number>;
const DISTILL_SAMPLE_CAP = 8;

export function emptyDistillRejections(): DistillRejections {
  return {
    "parse-error": 0,
    empty: 0,
    "too-long": 0,
    newline: 0,
    "invalid-date": 0,
    "missing-project": 0,
    "copy-80": 0,
    "invalid-project": 0,
    "save-error": 0,
  };
}

export interface DistillResult {
  calls: number;
  distilled: number;
  rejected: number;
  rejections: DistillRejections;
  capped: boolean;
  after: number | null;
  frontiers: DistillFrontiers | null;
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
  projectKey: string;
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
const sourceInstant = z.iso.datetime({ offset: true });
const storedInstant = z.iso.datetime();

/** Accept Z or a numeric offset. Knowledge rows store UTC with a Z suffix. */
export function distillCreatedAt(value: string): string | undefined {
  const parsed = sourceInstant.safeParse(value);
  if (!parsed.success) return undefined;
  if (/[zZ]$/u.test(parsed.data)) return parsed.data;
  const utc = new Date(parsed.data).toISOString();
  return storedInstant.safeParse(utc).success ? utc : undefined;
}

/**
 * Case-insensitive project mention. Hyphens, spaces and similar separators
 * are ignored, so `kosarev-space` matches "Kosarev Space" and "kosarevspace".
 */
export function mentionsProject(text: string, label: string): boolean {
  const fold = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s._:-]+/gu, "");
  const needle = fold(label);
  return needle.length > 0 && fold(text).includes(needle);
}

export function clipText(text: string, max: number) {
  let end = Math.min(text.length, max);
  if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? ""))
    end--;
  return text.slice(0, end);
}
// Prose for the 80-character copy check. Code spans, identifiers, ADR titles,
// URLs and markdown marks do not count. Whitespace is collapsed so a copy that
// only differs by spacing still matches. ADR 0011 still rejects 80 characters
// of contiguous prose.
function comparableProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, " $1 ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      " ",
    )
    .replace(/\b[0-9a-f]{16,}\b/giu, " ")
    .replace(/\bADR[-\s]?\d{3,4}(?:[-_][\p{L}\p{N}]+)*/giu, " ")
    .replace(/(?:\b[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]+\b/gu, " ")
    .replace(/[*_~#]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function copiesStoredBody(sentence: string, body: string) {
  const left = comparableProse(sentence);
  const right = comparableProse(body);
  if (left.length < 80 || right.length < 80) return false;
  for (let index = 0; index <= left.length - 80; index++) {
    if (right.includes(left.slice(index, index + 80))) return true;
  }
  return false;
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}
interface ScheduledSource {
  row: number;
  id: string;
  date: string;
  projectKey: string;
}
function stamp(value: { date: string; row: number }) {
  const parsed = Date.parse(value.date);
  return {
    time: Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY,
    row: value.row,
  };
}
function olderThan(
  source: { date: string; row: number },
  frontier: { date: string; row: number },
) {
  const left = stamp(source);
  const right = stamp(frontier);
  if (left.time !== right.time) return left.time < right.time;
  return left.row < right.row;
}
function newerFirst<T extends { date: string; row: number }>(a: T, b: T) {
  const left = stamp(a);
  const right = stamp(b);
  if (left.time !== right.time) return right.time - left.time;
  return right.row - left.row;
}
export function orderDistillSources<
  T extends { row: number; date: string; projectKey: string },
>(sources: readonly T[], frontiers: DistillFrontiers, limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const source of sources) {
    const frontier = frontiers[source.projectKey];
    if (frontier && !olderThan(source, frontier)) continue;
    const list = groups.get(source.projectKey) ?? [];
    list.push(source);
    groups.set(source.projectKey, list);
  }
  for (const list of groups.values()) list.sort(newerFirst);
  const chosen: T[] = [];
  const linked = [...groups.keys()]
    .filter((key) => key !== DISTILL_UNLINKED)
    .sort();
  while (chosen.length < limit) {
    let took = false;
    for (const key of linked) {
      if (chosen.length >= limit) break;
      const next = groups.get(key)?.shift();
      if (!next) continue;
      chosen.push(next);
      took = true;
    }
    if (!took) break;
  }
  const unlinked = groups.get(DISTILL_UNLINKED) ?? [];
  while (chosen.length < limit && unlinked.length) {
    const next = unlinked.shift();
    if (next) chosen.push(next);
  }
  return chosen;
}
function noteVisited(
  frontiers: Record<string, DistillFrontier>,
  source: ScheduledSource,
) {
  const current = frontiers[source.projectKey];
  if (!current || olderThan(source, current))
    frontiers[source.projectKey] = { date: source.date, row: source.row };
}
function oldestRow(frontiers: Record<string, DistillFrontier>): number | null {
  const rows = Object.values(frontiers).map((frontier) => frontier.row);
  return rows.length ? Math.min(...rows) : null;
}
function scheduled(
  db: DatabaseSync,
  areas: readonly string[],
): ScheduledSource[] {
  const marks = areas.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT s.rowid AS row, s.id,
        COALESCE(m.created_at, s.captured_at) AS date,
        (
          SELECT MIN(pa.project_id) FROM project_associations pa
          WHERE pa.record_kind = 'source' AND pa.record_id = s.id
            AND pa.origin IN ('configured', 'client') AND pa.status = 'linked'
        ) AS project_id
       FROM sources s
       LEFT JOIN source_metadata m ON m.source_id = s.id
       WHERE s.scope IN (${marks})
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_items k, json_each(k.source_refs) ref
           WHERE k.kind IN ('fact', 'decision')
             AND json_extract(k.creator, '$.name') = ?
             AND json_extract(ref.value, '$.sourceId') = s.id
         )`,
    )
    .all(...areas, DISTILL_CREATOR)
    .map((row) => ({
      row: Number(row.row),
      id: String(row.id),
      date: String(row.date),
      projectKey:
        row.project_id == null ? DISTILL_UNLINKED : String(row.project_id),
    }));
}
function rewindFrontiers(
  original: DistillFrontiers | null,
  visited: Record<string, DistillFrontier>,
  deferred: readonly { projectKey: string; date: string; row: number }[],
): DistillFrontiers | null {
  const frontiers: Record<string, DistillFrontier> = { ...visited };
  for (const source of deferred) {
    const current = frontiers[source.projectKey];
    // A frontier at or behind this source would skip it on the next run.
    if (!current || olderThan(source, current)) continue;
    const previous = original?.[source.projectKey];
    if (previous && olderThan(source, previous))
      frontiers[source.projectKey] = { date: previous.date, row: previous.row };
    else delete frontiers[source.projectKey];
  }
  return Object.keys(frontiers).length ? frontiers : null;
}
function takeSources(
  db: DatabaseSync,
  areas: readonly string[],
  frontiers: DistillFrontiers,
  limit: number,
  blocked?: ReadonlySet<string>,
): DistillSource[] {
  const pending = scheduled(db, areas).filter(
    (source) => !blocked?.has(source.id),
  );
  const chosen = orderDistillSources(pending, frontiers, limit);
  if (!chosen.length) return [];
  const marks = chosen.map(() => "?").join(", ");
  const loaded = new Map(
    db
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
         WHERE s.id IN (${marks})`,
      )
      .all(...chosen.map((source) => source.id))
      .map((row) => [String(row.id), row] as const),
  );
  return chosen.map((source) => {
    const row = loaded.get(source.id);
    if (!row) throw new Error("Missing distillation source");
    return {
      row: source.row,
      id: source.id,
      text: String(row.text),
      scope: String(row.scope),
      date: source.date,
      title: textOrNull(row.title),
      url: textOrNull(row.url),
      kind: textOrNull(row.kind),
      projectKey: source.projectKey,
    };
  });
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

function rejectionReason(input: {
  answers: Map<number, z.infer<typeof answerSchema>> | undefined;
  answer: z.infer<typeof answerSchema> | undefined;
  text: string;
  parsed: boolean;
  dated: boolean;
  linked: readonly string[];
  mention?: string;
  copied: boolean;
  proposal: boolean;
}): DistillRejectionReason | undefined {
  if (!input.answers || !input.answer) return "parse-error";
  if (!input.text.trim()) return "empty";
  if (input.text.length > 400) return "too-long";
  if (!input.parsed) return "parse-error";
  if (/[\r\n]/u.test(input.text)) return "newline";
  if (!input.dated) return "invalid-date";
  // A mapped source already carries its projects onto the item. Require a
  // mention only when the source is unmapped and the model proposes one.
  if (
    input.linked.length === 0 &&
    input.mention !== undefined &&
    !mentionsProject(input.text, input.mention)
  )
    return "missing-project";
  if (input.copied) return "copy-80";
  if (!input.proposal) return "invalid-project";
  return undefined;
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
  frontiers: DistillFrontiers | null;
  onLlmFailure?: (
    failure: LlmCallError,
    attempt: number,
    abandoned: boolean,
  ) => void;
  backoffMs?: readonly number[];
}): Promise<DistillResult> {
  const result: DistillResult = {
    calls: 0,
    distilled: 0,
    rejected: 0,
    rejections: emptyDistillRejections(),
    capped: false,
    after: null,
    frontiers: null,
    status: "completed",
    becameUnavailable: false,
  };
  let samples = 0;
  const reject = (reason: DistillRejectionReason, sample: string) => {
    result.rejections[reason]++;
    result.rejected++;
    if (samples >= DISTILL_SAMPLE_CAP) return;
    samples++;
    const text = redact(sample).replace(/\s+/gu, " ").trim().slice(0, 160);
    // Counts stay in tidy JSON. Samples are redacted, capped, and not stored.
    console.error(
      JSON.stringify({ event: "distill_rejection_sample", reason, text }),
    );
  };
  if (!input.llm) {
    result.status = "skipped_not_configured";
    return result;
  }
  if (input.unavailable) {
    result.status = "skipped_unavailable";
    result.capped = input.frontiers != null || input.resumeAfter != null;
    result.after = input.resumeAfter;
    result.frontiers = input.frontiers;
    return result;
  }
  const frontiers: Record<string, DistillFrontier> = {
    ...input.frontiers,
  };
  const blocked = new Set<string>();
  const deferred: DistillSource[] = [];
  const sentence = nonblankText(400);
  const publish = (failed: boolean) => {
    if (failed) {
      const progressed = Object.keys(frontiers).length > 0;
      result.becameUnavailable = true;
      result.status = "skipped_unavailable";
      result.capped = progressed;
      result.after = progressed ? oldestRow(frontiers) : null;
      result.frontiers = progressed ? frontiers : null;
      return result;
    }
    const more = takeSources(input.db, input.areas, frontiers, 1);
    result.capped = more.length > 0;
    result.after = result.capped ? oldestRow(frontiers) : null;
    result.frontiers = result.capped ? frontiers : null;
    result.status = result.capped ? "capped" : "completed";
    return result;
  };
  while (result.calls < input.callCap) {
    const batch = takeSources(
      input.db,
      input.areas,
      frontiers,
      input.batchSize,
      blocked,
    );
    if (!batch.length) break;
    let raw: unknown;
    try {
      raw = await askLlm(
        input.llm,
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
              visibleSourceText(sourceBody(source.text, source.title)),
              DISTILL_BODY_LIMIT,
            ),
          })),
        ),
        {
          canAttempt: () => result.calls < input.callCap,
          onAttempt: () => {
            result.calls++;
          },
          onFailure: (failure, attempt, abandoned) => {
            input.onLlmFailure?.(failure, attempt, abandoned);
          },
          ...(input.backoffMs ? { backoffMs: input.backoffMs } : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof LlmCallError)) throw error;
      // A dead processor stops the run. One transient or parse failure does not.
      if (error.reason === "unavailable") return publish(true);
      for (const source of batch) {
        blocked.add(source.id);
        deferred.push(source);
      }
      continue;
    }
    const answers = groupedAnswers(raw, batch.length);
    for (const [index, source] of batch.entries()) {
      const answer = answers?.get(index);
      const projects = linkedIds(input.db, source.id);
      const text = answer?.text.trim() ?? "";
      const parsed = sentence.safeParse(text);
      const createdAt = distillCreatedAt(source.date);
      const proposal = answer
        ? proposalFor(input.db, answer.project, projects)
        : { ok: false as const };
      const mention = !proposal.ok
        ? undefined
        : "proposedProjectId" in proposal
          ? proposal.proposedProjectId
          : "suggestedProjectName" in proposal
            ? proposal.suggestedProjectName
            : undefined;
      const body = sourceBody(source.text, source.title);
      const reason = rejectionReason({
        answers,
        answer,
        text,
        parsed: parsed.success,
        dated: createdAt !== undefined,
        linked: projects,
        ...(mention ? { mention } : {}),
        copied: copiesStoredBody(text, body),
        proposal: proposal.ok,
      });
      if (
        reason ||
        !answer ||
        !parsed.success ||
        createdAt === undefined ||
        !proposal.ok
      ) {
        if (reason) reject(reason, text);
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
        createdAt,
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
          reject("save-error", text);
          continue;
        }
        throw error;
      }
    }
    for (const source of batch) noteVisited(frontiers, source);
  }
  if (deferred.length) {
    const restored = rewindFrontiers(input.frontiers, frontiers, deferred);
    result.becameUnavailable = false;
    result.capped = true;
    result.frontiers = restored;
    result.after = restored ? oldestRow(restored) : null;
    result.status = "capped";
    return result;
  }
  return publish(false);
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
