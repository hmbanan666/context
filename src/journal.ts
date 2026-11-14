import type { DatabaseSync } from "node:sqlite";
import { latestReviewStatusSql } from "./review-status.js";

// ADR 0012. One replaceable paragraph per project and ISO week. Tidy writes it
// from distilled items only; the processor is not called and cannot approve it.
export const journalCharacterLimit = 800;
const journalCreator = {
  kind: "user",
  name: "context-tidy",
  version: "journal-v1",
};

export interface IsoWeek {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}
export interface JournalRefresh {
  readonly written: number;
  readonly removed: number;
  readonly unchanged: number;
}
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
interface WeekItem {
  id: string;
  text: string;
  sourceRefs: string;
}

export function installJournalMeta(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_journal_meta (
      knowledge_id TEXT PRIMARY KEY NOT NULL CHECK(length(knowledge_id) > 0),
      project_id TEXT NOT NULL,
      iso_week TEXT NOT NULL CHECK(length(iso_week) = 8),
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      item_ids TEXT NOT NULL,
      cited_ids TEXT NOT NULL,
      UNIQUE (project_id, iso_week)
    ) STRICT;
  `);
}
export function journalMetaReady(db: DatabaseSync): boolean {
  return !!db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'project_journal_meta'",
    )
    .get();
}

function parts(instant: Date, timeZone: string): ZonedParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of formatted)
    if (part.type !== "literal") map[part.type] = part.value;
  const hour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}
function timeZoneOffset(instant: Date, timeZone: string): number {
  const part = parts(instant, timeZone);
  const wall = Date.UTC(
    part.year,
    part.month - 1,
    part.day,
    part.hour,
    part.minute,
    part.second,
  );
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}
function zonedMidnight(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = new Date(wall - timeZoneOffset(new Date(wall), timeZone));
  const second = timeZoneOffset(first, timeZone);
  const instant = new Date(wall - second);
  const got = parts(instant, timeZone);
  if (got.year !== year || got.month !== month || got.day !== day || got.hour)
    throw new Error("Invalid timezone");
  return instant;
}
function ymd(date: Date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** ISO week of an instant in an IANA timezone. Bounds are zoned midnights. */
export function isoWeek(instant: Date, timeZone: string): IsoWeek {
  const local = parts(instant, timeZone);
  const utc = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const weekday = utc.getUTCDay() || 7;
  const thursday = new Date(utc);
  thursday.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const weekYear = thursday.getUTCFullYear();
  const januaryFourth = new Date(Date.UTC(weekYear, 0, 4));
  const januaryWeekday = januaryFourth.getUTCDay() || 7;
  const firstMonday = new Date(januaryFourth);
  firstMonday.setUTCDate(januaryFourth.getUTCDate() - (januaryWeekday - 1));
  const week =
    Math.round((thursday.getTime() - firstMonday.getTime()) / 604_800_000) + 1;
  const monday = new Date(utc);
  monday.setUTCDate(utc.getUTCDate() - (weekday - 1));
  const next = new Date(monday);
  next.setUTCDate(monday.getUTCDate() + 7);
  const startDay = ymd(monday);
  const endDay = ymd(next);
  const start = zonedMidnight(
    startDay.year,
    startDay.month,
    startDay.day,
    timeZone,
  );
  const end = zonedMidnight(endDay.year, endDay.month, endDay.day, timeZone);
  return {
    id: `${weekYear}-W${String(week).padStart(2, "0")}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
export function previousIsoWeek(week: IsoWeek, timeZone: string): IsoWeek {
  return isoWeek(new Date(Date.parse(week.start) - 1), timeZone);
}

/** Bounds for one ISO week id (`YYYY-Www`) in an IANA timezone. */
export function isoWeekById(id: string, timeZone: string): IsoWeek {
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(id))
    throw new Error("Invalid week");
  const year = Number(id.slice(0, 4));
  let cursor = isoWeek(new Date(Date.UTC(year, 0, 4, 12)), timeZone);
  for (let step = 0; step < 80 && cursor.id !== id; step++) {
    const forward = cursor.id < id;
    const probe = new Date(
      Date.parse(forward ? cursor.end : cursor.start) +
        (forward ? 1 : -1) * 12 * 3_600_000,
    );
    const next = isoWeek(probe, timeZone);
    if (next.id === cursor.id) break;
    cursor = next;
  }
  if (cursor.id !== id) throw new Error("Invalid week");
  return cursor;
}
export function journalId(projectId: string, weekId: string): string {
  return `journal:${projectId}:${weekId}`;
}
function characters(value: string): number {
  return Array.from(value).length;
}

/** Names the project and week and cites only the items that fit. */
export function journalParagraph(
  projectId: string,
  weekId: string,
  items: readonly { id: string; text: string }[],
): { text: string; citedIds: string[] } {
  const header = `${projectId} ${weekId}: `;
  let body = "";
  const citedIds: string[] = [];
  for (const item of items) {
    const sentence = item.text.trim().replace(/\s+/gu, " ");
    const piece = `${citedIds.length ? "; " : ""}${sentence} (${item.id})`;
    if (characters(header + body + piece) > journalCharacterLimit) break;
    body += piece;
    citedIds.push(item.id);
  }
  return { text: header + body, citedIds };
}

function citedRefs(items: readonly WeekItem[], citedIds: readonly string[]) {
  const cited = new Set(citedIds);
  const refs: string[] = [];
  for (const item of items) {
    if (!cited.has(item.id)) continue;
    const parsed = JSON.parse(item.sourceRefs) as { sourceId?: string }[];
    for (const ref of parsed) {
      if (!ref.sourceId || refs.includes(ref.sourceId)) continue;
      refs.push(ref.sourceId);
      if (refs.length === 8) return refs.map((sourceId) => ({ sourceId }));
    }
  }
  return refs.map((sourceId) => ({ sourceId }));
}
function weekItems(
  db: DatabaseSync,
  projectId: string,
  scope: string,
  week: IsoWeek,
): WeekItem[] {
  return db
    .prepare(
      `SELECT k.id, k.text, k.source_refs AS sourceRefs
       FROM knowledge_items k
       WHERE k.scope = ?
         AND k.kind IN ('fact', 'decision')
         AND source_timestamp(k.created_at) >= ?
         AND source_timestamp(k.created_at) < ?
         AND ${latestReviewStatusSql("k.id", "k.scope", "proposed")} <> 'rejected'
         AND EXISTS (
           SELECT 1 FROM project_associations pa
           WHERE pa.record_kind = 'knowledge' AND pa.record_id = k.id
             AND pa.project_id = ? AND pa.status = 'linked'
         )
       ORDER BY source_timestamp(k.created_at), k.id`,
    )
    .all(
      scope,
      Date.parse(week.start),
      Date.parse(week.end),
      projectId,
    ) as unknown as WeekItem[];
}
function deleteJournal(db: DatabaseSync, id: string, scope: string): boolean {
  const existed = db
    .prepare("SELECT 1 AS ok FROM knowledge_items WHERE id = ?")
    .get(id);
  db.prepare("DELETE FROM knowledge_items WHERE id = ?").run(id);
  db.prepare("DELETE FROM project_journal_meta WHERE knowledge_id = ?").run(id);
  db.prepare(
    "DELETE FROM project_associations WHERE record_kind = 'knowledge' AND record_id = ?",
  ).run(id);
  db.prepare(
    "DELETE FROM knowledge_relations WHERE scope = ? AND (from_id = ? OR to_id = ?)",
  ).run(scope, id, id);
  return !!existed;
}
function writeJournal(
  db: DatabaseSync,
  input: {
    id: string;
    projectId: string;
    scope: string;
    week: IsoWeek;
    text: string;
    refs: { sourceId: string }[];
    itemIds: string[];
    citedIds: string[];
    replaceText: boolean;
  },
): void {
  if (input.replaceText) {
    db.prepare("DELETE FROM knowledge_items WHERE id = ?").run(input.id);
    db.prepare(
      `INSERT INTO knowledge_items
        (id, scope, kind, text, source_refs, creator, created_at)
       VALUES (?, ?, 'journal', ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.scope,
      input.text,
      JSON.stringify(input.refs),
      JSON.stringify(journalCreator),
      input.week.start,
    );
    db.prepare(
      `INSERT OR IGNORE INTO project_associations
        (record_kind, record_id, project_id, origin, status)
       VALUES ('knowledge', ?, ?, 'client', 'linked')`,
    ).run(input.id, input.projectId);
  }
  db.prepare(
    `INSERT INTO project_journal_meta
      (knowledge_id, project_id, iso_week, week_start, week_end, item_ids, cited_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(knowledge_id) DO UPDATE SET
      item_ids = excluded.item_ids,
      cited_ids = excluded.cited_ids,
      week_start = excluded.week_start,
      week_end = excluded.week_end`,
  ).run(
    input.id,
    input.projectId,
    input.week.id,
    input.week.start,
    input.week.end,
    JSON.stringify(input.itemIds),
    JSON.stringify(input.citedIds),
  );
}

export function refreshProjectJournals(
  db: DatabaseSync,
  input: {
    areas: readonly string[];
    now: Date;
    timeZone: string;
    dryRun: boolean;
  },
): JournalRefresh {
  if (!input.areas.length) return { written: 0, removed: 0, unchanged: 0 };
  if (!input.dryRun) installJournalMeta(db);
  else if (!journalMetaReady(db))
    return { written: 0, removed: 0, unchanged: 0 };
  const current = isoWeek(input.now, input.timeZone);
  const weeks = [current, previousIsoWeek(current, input.timeZone)];
  const projects = db
    .prepare(
      `SELECT id, home_area AS homeArea FROM projects
       WHERE home_area IN (${input.areas.map(() => "?").join(",")})
       ORDER BY id`,
    )
    .all(...input.areas) as { id: string; homeArea: string }[];
  let written = 0;
  let removed = 0;
  let unchanged = 0;
  const run = () => {
    for (const project of projects) {
      for (const week of weeks) {
        const id = journalId(project.id, week.id);
        const items = weekItems(db, project.id, project.homeArea, week);
        if (!items.length) {
          if (input.dryRun) continue;
          if (deleteJournal(db, id, project.homeArea)) removed++;
          continue;
        }
        const paragraph = journalParagraph(project.id, week.id, items);
        if (!paragraph.citedIds.length) {
          if (!input.dryRun && deleteJournal(db, id, project.homeArea))
            removed++;
          continue;
        }
        const refs = citedRefs(items, paragraph.citedIds);
        const itemIds = items.map((item) => item.id).sort();
        const citedIds = paragraph.citedIds;
        const existing = db
          .prepare(
            `SELECT k.text, k.source_refs AS sourceRefs,
              m.item_ids AS itemIds, m.cited_ids AS citedIds
             FROM knowledge_items k
             LEFT JOIN project_journal_meta m ON m.knowledge_id = k.id
             WHERE k.id = ?`,
          )
          .get(id) as
          | {
              text: string;
              sourceRefs: string;
              itemIds: string | null;
              citedIds: string | null;
            }
          | undefined;
        const sameText =
          existing?.text === paragraph.text &&
          existing.sourceRefs === JSON.stringify(refs);
        const sameSet =
          existing?.itemIds === JSON.stringify(itemIds) &&
          existing.citedIds === JSON.stringify(citedIds);
        if (sameText && sameSet) {
          unchanged++;
          continue;
        }
        if (input.dryRun) continue;
        writeJournal(db, {
          id,
          projectId: project.id,
          scope: project.homeArea,
          week,
          text: paragraph.text,
          refs,
          itemIds,
          citedIds,
          replaceText: !sameText,
        });
        written++;
      }
    }
  };
  if (input.dryRun || db.isTransaction) {
    run();
    return { written, removed, unchanged };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return { written, removed, unchanged };
}

/**
 * Ordinary knowledge stays inside the source-date window. A journal is the
 * ISO week stored beside it, included when that week overlaps the request.
 */
export function knowledgeWindowSql(
  db: DatabaseSync,
  alias: "k" | "r",
  from?: string,
  until?: string,
): { sql: string; params: number[] } {
  const missing = "s.id IS NULL";
  const date = "source_timestamp(COALESCE(m.created_at,s.captured_at))";
  const dated = [missing];
  const params: number[] = [];
  if (from) {
    dated.push(`${date} < ?`);
    params.push(Date.parse(from));
  }
  if (until) {
    dated.push(`${date} >= ?`);
    params.push(Date.parse(until));
  }
  const join = `json_each(${alias}.source_refs) ref LEFT JOIN sources s ON s.id=json_extract(ref.value,'$.sourceId') AND s.scope=${alias}.scope LEFT JOIN source_metadata m ON m.source_id=s.id`;
  const ordinary = `NOT EXISTS (SELECT 1 FROM ${join} WHERE ${dated.join(" OR ")})`;
  if (!journalMetaReady(db)) return { sql: ordinary, params };
  const overlap: string[] = [];
  if (from) {
    overlap.push("source_timestamp(w.week_end) > ?");
    params.push(Date.parse(from));
  }
  if (until) {
    overlap.push("source_timestamp(w.week_start) < ?");
    params.push(Date.parse(until));
  }
  const week = overlap.length ? overlap.join(" AND ") : "1";
  return {
    sql: `(
      (${alias}.kind <> 'journal' AND ${ordinary})
      OR (${alias}.kind = 'journal'
        AND NOT EXISTS (SELECT 1 FROM ${join} WHERE ${missing})
        AND EXISTS (
          SELECT 1 FROM project_journal_meta w
          WHERE w.knowledge_id = ${alias}.id AND ${week}
        ))
    )`,
    params,
  };
}
