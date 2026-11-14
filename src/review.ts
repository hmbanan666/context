import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { identifierSchema, scopeSchema } from "./contracts.js";
import { isoWeekById } from "./journal.js";
import {
  createProject,
  hasProject,
  ProjectExists,
  projectIdSchema,
  projectNameSchema,
  UnknownProject,
} from "./projects.js";
import {
  itemReviewPredicateSql,
  latestReviewStatusSql,
  projectReviewSubject,
} from "./review-status.js";

// Owner approval is a CLI action (ADR 0010, ADR 0012). It appends
// knowledge_reviews and never writes a supersedes relation.
const listLimit = 500;
const idLimit = 100;
const reviewer = "owner";
// ADR 0008 removed signatures. The historical column is still NOT NULL.
const unsignedReceipt = "{}";
const pinPrefix = "pin.";
const instant = z.iso.datetime({ offset: true });
const reviewKindSchema = z.enum(["fact", "decision", "project", "pin"]);
export type ReviewKind = z.infer<typeof reviewKindSchema>;
export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputError";
  }
}
export class UnknownProposal extends Error {
  constructor(readonly id: string) {
    super(`Unknown proposal: ${id}`);
    this.name = "UnknownProposal";
  }
}
export interface ReviewListInput {
  readonly projectId?: string | undefined;
  readonly kind?: ReviewKind | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly week?: string | undefined;
  readonly timeZone?: string | undefined;
}
export interface OpenProposal {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly scope: string;
  readonly createdAt: string;
  readonly text: string;
  readonly projectIds?: readonly string[];
  readonly projectId?: string;
  readonly suggestedName?: string;
  readonly recordKind?: "source" | "knowledge";
  readonly recordId?: string;
  readonly pinned?: true;
}
export interface ReviewDecision {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly status: "approved" | "rejected";
  readonly changed: boolean;
  readonly reviewedAt: string;
}
export interface DecideProposalsInput {
  readonly action: "approved" | "rejected";
  readonly ids?: readonly string[];
  readonly projectId?: string;
  readonly week?: string;
  readonly kind?: ReviewKind;
  readonly assign?: {
    readonly id: string;
    readonly name?: string;
    readonly home?: string;
  };
  readonly areas: readonly string[];
  readonly timeZone: string;
}
interface Bounds {
  readonly since: number | null;
  readonly until: number | null;
}
interface RecordView {
  readonly scope: string;
  readonly text: string;
  readonly createdAt: string;
}
type ItemTarget = {
  readonly action: "item";
  readonly id: string;
  readonly kind: "fact" | "decision" | "pin";
  readonly itemId: string;
  readonly scope: string;
};
type LinkTarget = {
  readonly action: "link";
  readonly id: string;
  readonly recordKind: "source" | "knowledge";
  readonly recordId: string;
  readonly projectId: string;
  readonly scope: string;
};
type NameTarget = {
  readonly action: "name";
  readonly id: string;
  readonly recordKind: "source" | "knowledge";
  readonly recordId: string;
  readonly scope: string;
  readonly suggestedName: string;
  readonly status: "proposed" | "approved" | "rejected";
  readonly storedProjectId: string | null;
};
type Target = ItemTarget | LinkTarget | NameTarget;

function boundsOf(input: ReviewListInput): Bounds {
  if (input.week && (input.since || input.until))
    throw new ReviewInputError("Pass a week or a date range, not both");
  let since = input.since;
  let until = input.until;
  if (input.week) {
    if (!input.timeZone) throw new ReviewInputError("Invalid week");
    let week: { start: string; end: string };
    try {
      week = isoWeekById(input.week, input.timeZone);
    } catch {
      throw new ReviewInputError("Invalid week");
    }
    since = week.start;
    until = week.end;
  }
  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;
  if (
    sinceMs !== null &&
    untilMs !== null &&
    (!Number.isFinite(sinceMs) ||
      !Number.isFinite(untilMs) ||
      sinceMs >= untilMs)
  )
    throw new ReviewInputError("since must precede until");
  return { since: sinceMs, until: untilMs };
}
function dateClause(column: string): string {
  return `AND (? IS NULL OR source_timestamp(${column}) >= ?)
    AND (? IS NULL OR source_timestamp(${column}) < ?)`;
}
function dateParams(bounds: Bounds): (number | null)[] {
  return [bounds.since, bounds.since, bounds.until, bounds.until];
}
function assertProject(db: DatabaseSync, projectId: string | undefined): void {
  if (projectId && !hasProject(db, projectId))
    throw new UnknownProject([projectId]);
}
function linkedIds(
  db: DatabaseSync,
  kind: "source" | "knowledge",
  id: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT project_id AS projectId FROM project_associations
         WHERE record_kind = ? AND record_id = ? AND status = 'linked'
         ORDER BY project_id`,
      )
      .all(kind, id) as { projectId: string }[]
  ).map((row) => row.projectId);
}
function pinnedIds(db: DatabaseSync, projectId?: string): Set<string> {
  const rows = db
    .prepare("SELECT project_id AS projectId, pinned FROM project_profiles")
    .all() as { projectId: string; pinned: string }[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (projectId && row.projectId !== projectId) continue;
    const parsed = JSON.parse(row.pinned) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const id of parsed) if (typeof id === "string") ids.add(id);
  }
  return ids;
}
function recordOf(
  db: DatabaseSync,
  kind: "source" | "knowledge",
  id: string,
): RecordView | undefined {
  if (kind === "knowledge") {
    const row = db
      .prepare(
        `SELECT scope, text, created_at AS createdAt
         FROM knowledge_items WHERE id = ?`,
      )
      .get(id) as RecordView | undefined;
    return row
      ? {
          scope: String(row.scope),
          text: String(row.text),
          createdAt: String(row.createdAt),
        }
      : undefined;
  }
  const row = db
    .prepare(
      `SELECT s.scope AS scope, substr(s.text, 1, 400) AS text,
        COALESCE(m.created_at, s.captured_at) AS createdAt
       FROM sources s LEFT JOIN source_metadata m ON m.source_id = s.id
       WHERE s.id = ?`,
    )
    .get(id) as RecordView | undefined;
  return row
    ? {
        scope: String(row.scope),
        text: String(row.text),
        createdAt: String(row.createdAt),
      }
    : undefined;
}
function itemRows(
  db: DatabaseSync,
  input: ReviewListInput,
  bounds: Bounds,
  pins: Set<string>,
): OpenProposal[] {
  if (input.kind === "project") return [];
  if (input.kind === "pin" && !pins.size) return [];
  const kind =
    input.kind === "fact" || input.kind === "decision" ? input.kind : null;
  const project = input.kind === "pin" ? null : (input.projectId ?? null);
  const pinList = input.kind === "pin" ? [...pins] : [];
  const rows = db
    .prepare(
      `SELECT id, scope, kind, text, createdAt FROM (
        SELECT k.id AS id, k.scope AS scope, k.kind AS kind, k.text AS text,
          k.created_at AS createdAt,
          ${latestReviewStatusSql("k.id", "k.scope", "proposed")} AS status
        FROM knowledge_items k
        WHERE k.kind IN ('fact', 'decision')
          ${pinList.length ? `AND k.id IN (${pinList.map(() => "?").join(",")})` : ""}
      )
      WHERE status = 'proposed'
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM project_associations pa
          WHERE pa.record_kind = 'knowledge' AND pa.record_id = id
            AND pa.project_id = ? AND pa.status = 'linked'
        ))
        ${dateClause("createdAt")}
      ORDER BY createdAt, id
      LIMIT ?`,
    )
    .all(
      ...pinList,
      kind,
      kind,
      project,
      project,
      ...dateParams(bounds),
      listLimit + 1,
    ) as {
    id: string;
    scope: string;
    kind: "fact" | "decision";
    text: string;
    createdAt: string;
  }[];
  return rows.map((row) => {
    const projects = linkedIds(db, "knowledge", row.id);
    const pinned = pins.has(row.id);
    return {
      id: input.kind === "pin" ? `${pinPrefix}${row.id}` : row.id,
      kind: input.kind === "pin" ? "pin" : row.kind,
      scope: row.scope,
      createdAt: row.createdAt,
      text: row.text,
      ...(projects.length ? { projectIds: projects } : {}),
      ...(pinned ? { pinned: true } : {}),
    };
  });
}
function linkRows(
  db: DatabaseSync,
  input: ReviewListInput,
  bounds: Bounds,
): OpenProposal[] {
  if (input.kind && input.kind !== "project") return [];
  const project = input.projectId ?? null;
  const knowledge = db
    .prepare(
      `SELECT pa.project_id AS projectId, k.id AS recordId, k.scope AS scope,
        k.text AS text, k.created_at AS createdAt
       FROM project_associations pa
       JOIN knowledge_items k ON k.id = pa.record_id
       WHERE pa.record_kind = 'knowledge' AND pa.origin = 'proposed'
         AND pa.status = 'proposed'
         AND (? IS NULL OR pa.project_id = ?)
         ${dateClause("k.created_at")}
       ORDER BY k.created_at, k.id
       LIMIT ?`,
    )
    .all(project, project, ...dateParams(bounds), listLimit + 1) as {
    projectId: string;
    recordId: string;
    scope: string;
    text: string;
    createdAt: string;
  }[];
  const sources = db
    .prepare(
      `SELECT pa.project_id AS projectId, s.id AS recordId, s.scope AS scope,
        substr(s.text, 1, 400) AS text,
        COALESCE(m.created_at, s.captured_at) AS createdAt
       FROM project_associations pa
       JOIN sources s ON s.id = pa.record_id
       LEFT JOIN source_metadata m ON m.source_id = s.id
       WHERE pa.record_kind = 'source' AND pa.origin = 'proposed'
         AND pa.status = 'proposed'
         AND (? IS NULL OR pa.project_id = ?)
         ${dateClause("COALESCE(m.created_at, s.captured_at)")}
       ORDER BY createdAt, s.id
       LIMIT ?`,
    )
    .all(project, project, ...dateParams(bounds), listLimit + 1) as {
    projectId: string;
    recordId: string;
    scope: string;
    text: string;
    createdAt: string;
  }[];
  return [
    ...knowledge.map((row) => linkProposal(row, "knowledge")),
    ...sources.map((row) => linkProposal(row, "source")),
  ];
}
function linkProposal(
  row: {
    projectId: string;
    recordId: string;
    scope: string;
    text: string;
    createdAt: string;
  },
  recordKind: "source" | "knowledge",
): OpenProposal {
  return {
    id: linkId(recordKind, row.recordId, row.projectId),
    kind: "project",
    scope: row.scope,
    createdAt: String(row.createdAt),
    text: String(row.text),
    projectId: row.projectId,
    recordKind,
    recordId: row.recordId,
  };
}

function nameRows(
  db: DatabaseSync,
  input: ReviewListInput,
  bounds: Bounds,
): OpenProposal[] {
  if (input.kind && input.kind !== "project") return [];
  const project = input.projectId ?? null;
  const knowledge = db
    .prepare(
      `SELECT p.id AS id, p.suggested_name AS suggestedName,
        k.id AS recordId, k.scope AS scope, k.text AS text,
        k.created_at AS createdAt
       FROM project_proposals p
       JOIN knowledge_items k ON k.id = p.record_id
       WHERE p.record_kind = 'knowledge' AND p.status = 'proposed'
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM project_associations pa
           WHERE pa.record_kind = p.record_kind AND pa.record_id = p.record_id
             AND pa.project_id = ? AND pa.status IN ('linked', 'proposed')
         ))
         ${dateClause("k.created_at")}
       ORDER BY k.created_at, p.id
       LIMIT ?`,
    )
    .all(project, project, ...dateParams(bounds), listLimit + 1) as {
    id: string;
    suggestedName: string;
    recordId: string;
    scope: string;
    text: string;
    createdAt: string;
  }[];
  const sources = db
    .prepare(
      `SELECT p.id AS id, p.suggested_name AS suggestedName,
        s.id AS recordId, s.scope AS scope, substr(s.text, 1, 400) AS text,
        COALESCE(m.created_at, s.captured_at) AS createdAt
       FROM project_proposals p
       JOIN sources s ON s.id = p.record_id
       LEFT JOIN source_metadata m ON m.source_id = s.id
       WHERE p.record_kind = 'source' AND p.status = 'proposed'
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM project_associations pa
           WHERE pa.record_kind = p.record_kind AND pa.record_id = p.record_id
             AND pa.project_id = ? AND pa.status IN ('linked', 'proposed')
         ))
         ${dateClause("COALESCE(m.created_at, s.captured_at)")}
       ORDER BY createdAt, p.id
       LIMIT ?`,
    )
    .all(project, project, ...dateParams(bounds), listLimit + 1) as {
    id: string;
    suggestedName: string;
    recordId: string;
    scope: string;
    text: string;
    createdAt: string;
  }[];
  return [
    ...knowledge.map((row) => nameProposal(row, "knowledge")),
    ...sources.map((row) => nameProposal(row, "source")),
  ];
}
function nameProposal(
  row: {
    id: string;
    suggestedName: string;
    recordId: string;
    scope: string;
    text: string;
    createdAt: string;
  },
  recordKind: "source" | "knowledge",
): OpenProposal {
  return {
    id: row.id,
    kind: "project",
    scope: row.scope,
    createdAt: String(row.createdAt),
    text: String(row.text),
    suggestedName: row.suggestedName,
    recordKind,
    recordId: row.recordId,
  };
}
function collect(db: DatabaseSync, input: ReviewListInput): OpenProposal[] {
  const parsed = z
    .strictObject({
      projectId: projectIdSchema.optional(),
      kind: reviewKindSchema.optional(),
      since: instant.optional(),
      until: instant.optional(),
      week: z
        .string()
        .regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/)
        .optional(),
      timeZone: z.string().min(1).max(64).optional(),
    })
    .parse(input);
  assertProject(db, parsed.projectId);
  const bounds = boundsOf(parsed);
  const pins = pinnedIds(
    db,
    parsed.kind === "pin" ? parsed.projectId : undefined,
  );
  const rows = [
    ...itemRows(db, parsed, bounds, pins),
    ...linkRows(db, parsed, bounds),
    ...nameRows(db, parsed, bounds),
  ];
  return rows.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
export function listOpenProposals(
  db: DatabaseSync,
  input: ReviewListInput = {},
): { proposals: OpenProposal[]; truncated: boolean } {
  const rows = collect(db, input);
  return {
    proposals: rows.slice(0, listLimit),
    truncated: rows.length > listLimit,
  };
}

function linkId(
  kind: "source" | "knowledge",
  recordId: string,
  projectId: string,
): string {
  return `link.${kind}.${recordId}.${projectId}`;
}
function parseLink(id: string):
  | {
      recordKind: "source" | "knowledge";
      recordId: string;
      projectId: string;
    }
  | undefined {
  const match = /^link\.(source|knowledge)\.([^.]+)\.(.+)$/.exec(id);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const recordKind = match[1] === "source" ? "source" : "knowledge";
  const recordId = identifierSchema.safeParse(match[2]);
  const projectId = projectIdSchema.safeParse(match[3]);
  if (!recordId.success || !projectId.success) return undefined;
  return { recordKind, recordId: recordId.data, projectId: projectId.data };
}
function itemTarget(
  db: DatabaseSync,
  id: string,
  kind: "fact" | "decision" | "pin",
  itemId: string,
): ItemTarget {
  const row = db
    .prepare(
      `SELECT scope, kind FROM knowledge_items
       WHERE id = ? AND kind IN ('fact', 'decision')`,
    )
    .get(itemId) as { scope: string; kind: string } | undefined;
  if (!row) throw new UnknownProposal(id);
  if (kind === "pin") {
    if (row.kind !== "decision" || !pinnedIds(db).has(itemId))
      throw new UnknownProposal(id);
  } else if (row.kind !== kind) throw new UnknownProposal(id);
  return { action: "item", id, kind, itemId, scope: String(row.scope) };
}
function resolveId(db: DatabaseSync, id: string): Target {
  if (id.startsWith(pinPrefix))
    return itemTarget(db, id, "pin", id.slice(pinPrefix.length));
  const link = parseLink(id);
  if (link) {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM project_associations
         WHERE record_kind = ? AND record_id = ? AND project_id = ?
           AND origin = 'proposed'`,
      )
      .get(link.recordKind, link.recordId, link.projectId);
    const record = recordOf(db, link.recordKind, link.recordId);
    if (!row || !record) throw new UnknownProposal(id);
    return { action: "link", id, ...link, scope: record.scope };
  }
  if (id.startsWith("proposal:")) {
    const row = db
      .prepare(
        `SELECT record_kind AS recordKind, record_id AS recordId,
          suggested_name AS suggestedName, status, project_id AS projectId
         FROM project_proposals WHERE id = ?`,
      )
      .get(id) as
      | {
          recordKind: "source" | "knowledge";
          recordId: string;
          suggestedName: string;
          status: "proposed" | "approved" | "rejected";
          projectId: string | null;
        }
      | undefined;
    if (!row) throw new UnknownProposal(id);
    const record = recordOf(db, row.recordKind, row.recordId);
    if (!record) throw new UnknownProposal(id);
    return {
      action: "name",
      id,
      recordKind: row.recordKind,
      recordId: row.recordId,
      scope: record.scope,
      suggestedName: row.suggestedName,
      status: row.status,
      storedProjectId: row.projectId,
    };
  }
  const row = db
    .prepare(
      `SELECT kind FROM knowledge_items
       WHERE id = ? AND kind IN ('fact', 'decision')`,
    )
    .get(id) as { kind: "fact" | "decision" } | undefined;
  if (!row) throw new UnknownProposal(id);
  return itemTarget(db, id, row.kind, id);
}
function targetsFromList(rows: readonly OpenProposal[]): Target[] {
  return rows.map((row) => {
    if (row.kind === "fact" || row.kind === "decision" || row.kind === "pin") {
      const itemId =
        row.kind === "pin" ? row.id.slice(pinPrefix.length) : row.id;
      return {
        action: "item" as const,
        id: row.id,
        kind: row.kind,
        itemId,
        scope: row.scope,
      };
    }
    if (row.suggestedName && row.recordKind && row.recordId)
      return {
        action: "name" as const,
        id: row.id,
        recordKind: row.recordKind,
        recordId: row.recordId,
        scope: row.scope,
        suggestedName: row.suggestedName,
        status: "proposed" as const,
        storedProjectId: null,
      };
    if (!row.projectId || !row.recordKind || !row.recordId)
      throw new UnknownProposal(row.id);
    return {
      action: "link" as const,
      id: row.id,
      recordKind: row.recordKind,
      recordId: row.recordId,
      projectId: row.projectId,
      scope: row.scope,
    };
  });
}
function insertReview(
  db: DatabaseSync,
  knowledgeId: string,
  scope: string,
  status: "approved" | "rejected",
  evidence: string,
  reviewedAt: string,
): void {
  db.prepare(
    `INSERT INTO knowledge_reviews (
      id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    knowledgeId,
    scope,
    status,
    evidence,
    reviewer,
    unsignedReceipt,
    reviewedAt,
  );
}
function projectEvidence(
  proposal: string,
  fields: Record<string, string | null | undefined>,
): string {
  const body: Record<string, string> = {
    subject: projectReviewSubject,
    proposal,
  };
  for (const [key, value] of Object.entries(fields))
    if (value) body[key] = value;
  return JSON.stringify(body);
}
function itemAuditTime(
  db: DatabaseSync,
  id: string,
  scope: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT created_at AS createdAt FROM knowledge_reviews
       WHERE knowledge_id = ? AND scope = ?
         AND ${itemReviewPredicateSql("evidence")}
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(id, scope) as { createdAt?: string } | undefined;
  return row?.createdAt ? String(row.createdAt) : undefined;
}
function applyItem(
  db: DatabaseSync,
  target: ItemTarget,
  action: "approved" | "rejected",
  reviewedAt: string,
): ReviewDecision {
  const row = db
    .prepare(
      `SELECT ${latestReviewStatusSql("k.id", "k.scope", "proposed")} AS status
       FROM knowledge_items k WHERE k.id = ? AND k.scope = ?`,
    )
    .get(target.itemId, target.scope) as { status?: string } | undefined;
  if (row?.status === action) {
    return {
      id: target.id,
      kind: target.kind,
      status: action,
      changed: false,
      reviewedAt: itemAuditTime(db, target.itemId, target.scope) ?? reviewedAt,
    };
  }
  insertReview(db, target.itemId, target.scope, action, "[]", reviewedAt);
  return {
    id: target.id,
    kind: target.kind,
    status: action,
    changed: true,
    reviewedAt,
  };
}
function applyLink(
  db: DatabaseSync,
  target: LinkTarget,
  action: "approved" | "rejected",
  reviewedAt: string,
): ReviewDecision {
  const desired = action === "approved" ? "linked" : "rejected";
  const row = db
    .prepare(
      `SELECT status, reviewed_at AS reviewedAt FROM project_associations
       WHERE record_kind = ? AND record_id = ? AND project_id = ?
         AND origin = 'proposed'`,
    )
    .get(target.recordKind, target.recordId, target.projectId) as
    | { status: string; reviewedAt: string | null }
    | undefined;
  if (!row) throw new UnknownProposal(target.id);
  if (row.status === desired) {
    return {
      id: target.id,
      kind: "project",
      status: action,
      changed: false,
      reviewedAt: row.reviewedAt ? String(row.reviewedAt) : reviewedAt,
    };
  }
  setProposedLink(
    db,
    target.recordKind,
    target.recordId,
    target.projectId,
    desired,
    reviewedAt,
  );
  if (target.recordKind === "knowledge")
    for (const sourceId of citedSourceIds(db, "knowledge", target.recordId))
      setProposedLink(
        db,
        "source",
        sourceId,
        target.projectId,
        desired,
        reviewedAt,
      );
  if (target.recordKind === "knowledge")
    insertReview(
      db,
      target.recordId,
      target.scope,
      action,
      projectEvidence(target.id, { projectId: target.projectId }),
      reviewedAt,
    );
  return {
    id: target.id,
    kind: "project",
    status: action,
    changed: true,
    reviewedAt,
  };
}
function setProposedLink(
  db: DatabaseSync,
  kind: "source" | "knowledge",
  recordId: string,
  projectId: string,
  status: "linked" | "rejected",
  reviewedAt: string,
): void {
  if (status === "rejected") {
    db.prepare(
      `UPDATE project_associations
       SET status = 'rejected', reviewer = ?, reviewed_at = ?
       WHERE record_kind = ? AND record_id = ? AND project_id = ?
         AND origin = 'proposed'`,
    ).run(reviewer, reviewedAt, kind, recordId, projectId);
    return;
  }
  db.prepare(
    `INSERT INTO project_associations (
      record_kind, record_id, project_id, origin, status, reviewer, reviewed_at
    ) VALUES (?, ?, ?, 'proposed', 'linked', ?, ?)
    ON CONFLICT(record_kind, record_id, project_id, origin) DO UPDATE SET
      status = 'linked',
      reviewer = excluded.reviewer,
      reviewed_at = excluded.reviewed_at`,
  ).run(kind, recordId, projectId, reviewer, reviewedAt);
}
function citedSourceIds(
  db: DatabaseSync,
  kind: "source" | "knowledge",
  recordId: string,
): string[] {
  if (kind === "source") return [recordId];
  const row = db
    .prepare(
      "SELECT source_refs AS sourceRefs FROM knowledge_items WHERE id = ?",
    )
    .get(recordId) as { sourceRefs?: string } | undefined;
  if (!row?.sourceRefs) return [];
  const parsed = JSON.parse(row.sourceRefs) as { sourceId?: string }[];
  return parsed.flatMap((ref) => (ref.sourceId ? [ref.sourceId] : []));
}
function applyName(
  db: DatabaseSync,
  target: NameTarget,
  action: "approved" | "rejected",
  assign: { id: string } | undefined,
  reviewedAt: string,
): ReviewDecision {
  const row = db
    .prepare(
      `SELECT status, project_id AS projectId, source_id AS sourceId,
        reviewed_at AS reviewedAt
       FROM project_proposals WHERE id = ?`,
    )
    .get(target.id) as
    | {
        status: "proposed" | "approved" | "rejected";
        projectId: string | null;
        sourceId: string;
        reviewedAt: string | null;
      }
    | undefined;
  if (!row) throw new UnknownProposal(target.id);
  const done = (reviewed: string | null): ReviewDecision => ({
    id: target.id,
    kind: "project",
    status: action,
    changed: false,
    reviewedAt: reviewed ? String(reviewed) : reviewedAt,
  });
  if (action === "rejected") {
    if (row.status === "rejected") return done(row.reviewedAt);
    if (row.status === "approved" && row.projectId) {
      setProposedLink(
        db,
        target.recordKind,
        target.recordId,
        row.projectId,
        "rejected",
        reviewedAt,
      );
      if (target.recordKind === "knowledge")
        setProposedLink(
          db,
          "source",
          row.sourceId,
          row.projectId,
          "rejected",
          reviewedAt,
        );
    }
    db.prepare(
      `UPDATE project_proposals
       SET status = 'rejected', reviewer = ?, reviewed_at = ? WHERE id = ?`,
    ).run(reviewer, reviewedAt, target.id);
  } else {
    if (row.status === "approved") {
      if (!assign || row.projectId === assign.id) return done(row.reviewedAt);
      throw new ReviewInputError("Proposal is already decided");
    }
    if (!assign)
      throw new ReviewInputError("A new project proposal needs --assign");
    if (!hasProject(db, assign.id))
      throw new ReviewInputError("A new project proposal needs --assign");
    setProposedLink(
      db,
      target.recordKind,
      target.recordId,
      assign.id,
      "linked",
      reviewedAt,
    );
    if (target.recordKind === "knowledge")
      setProposedLink(
        db,
        "source",
        row.sourceId,
        assign.id,
        "linked",
        reviewedAt,
      );
    db.prepare(
      `UPDATE project_proposals
       SET status = 'approved', project_id = ?, reviewer = ?, reviewed_at = ?
       WHERE id = ?`,
    ).run(assign.id, reviewer, reviewedAt, target.id);
  }
  if (target.recordKind === "knowledge")
    insertReview(
      db,
      target.recordId,
      target.scope,
      action,
      projectEvidence(target.id, {
        projectId: action === "approved" ? assign?.id : row.projectId,
        suggestedName: target.suggestedName,
      }),
      reviewedAt,
    );
  return {
    id: target.id,
    kind: "project",
    status: action,
    changed: true,
    reviewedAt,
  };
}
function ensureAssigned(
  db: DatabaseSync,
  needing: readonly NameTarget[],
  assign: NonNullable<DecideProposalsInput["assign"]>,
  areas: readonly string[],
): void {
  const id = projectIdSchema.parse(assign.id);
  if (hasProject(db, id)) return;
  const homes = new Set(needing.map((target) => target.scope));
  const home = assign.home ?? (homes.size === 1 ? [...homes][0] : undefined);
  if (!home) throw new ReviewInputError("Pass --home for the new project");
  if (!areas.includes(scopeSchema.parse(home)))
    throw new ReviewInputError("Unknown area");
  const names = new Set(needing.map((target) => target.suggestedName));
  const name = assign.name ?? (names.size === 1 ? [...names][0] : undefined);
  if (!name) throw new ReviewInputError("Pass --name for the new project");
  try {
    createProject(db, {
      id,
      name: projectNameSchema.parse(name),
      homeArea: home,
    });
  } catch (error) {
    if (error instanceof ProjectExists) return;
    throw error;
  }
}
function transaction<T>(db: DatabaseSync, run: () => T): T {
  if (db.isTransaction) return run();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function decideProposals(
  db: DatabaseSync,
  input: DecideProposalsInput,
): { decisions: ReviewDecision[] } {
  const action = z.enum(["approved", "rejected"]).parse(input.action);
  const ids = input.ids ? [...input.ids] : undefined;
  if (ids && (input.projectId || input.week || input.kind))
    throw new ReviewInputError("Pass proposal ids or a project week, not both");
  if (ids && !ids.length)
    throw new ReviewInputError("Pass proposal ids or a project and week");
  if (!ids && !(input.projectId && input.week))
    throw new ReviewInputError("Pass proposal ids or a project and week");
  if (ids && ids.length > idLimit)
    throw new ReviewInputError("Too many proposal ids");
  return transaction(db, () => {
    const resolved = ids
      ? [...new Set(ids)].map((id) => resolveId(db, id))
      : targetsFromList(
          collect(db, {
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.week ? { week: input.week } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            timeZone: input.timeZone,
          }),
        );
    if (!ids && resolved.length > listLimit)
      throw new ReviewInputError(
        "Narrow the review; more than 500 proposals match",
      );
    const assign = input.assign
      ? {
          id: projectIdSchema.parse(input.assign.id),
          ...(input.assign.name ? { name: input.assign.name } : {}),
          ...(input.assign.home ? { home: input.assign.home } : {}),
        }
      : undefined;
    const names = resolved.filter(
      (target): target is NameTarget => target.action === "name",
    );
    const needing = names.filter(
      (target) => action === "approved" && target.status !== "approved",
    );
    if (action === "rejected" && assign)
      throw new ReviewInputError("--assign applies to a new project proposal");
    if (assign && !names.length)
      throw new ReviewInputError("--assign applies to a new project proposal");
    if (needing.length) {
      if (!assign)
        throw new ReviewInputError("A new project proposal needs --assign");
      ensureAssigned(db, needing, assign, input.areas);
    }
    const reviewedAt = new Date().toISOString();
    return {
      decisions: resolved.map((target) => {
        if (target.action === "item")
          return applyItem(db, target, action, reviewedAt);
        if (target.action === "link")
          return applyLink(db, target, action, reviewedAt);
        return applyName(db, target, action, assign, reviewedAt);
      }),
    };
  });
}

export function proposalLinkId(
  kind: "source" | "knowledge",
  recordId: string,
  projectId: string,
): string {
  return linkId(kind, recordId, projectId);
}
