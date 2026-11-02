import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { z } from "zod";
import { E5_VERSION } from "./embedding-model.js";
import { KnowledgeStore } from "./knowledge.js";
import type { Llm } from "./llm.js";

// Conservative synthetic calibration; see docs/search.md. Never merge a
// changed number/negation merely because its semantic vector is almost equal.
const DUPLICATE_COSINE = 0.97;
const MIN_DUPLICATE_LENGTH = 80;
const SUPERSEDE_COSINE = 0.85;
const MAX_PAIRS = 200;
const BATCH_SIZE = 25;
const MAX_LLM_CALLS = 12;
const MAX_FACT_LENGTH = 1500;
const supersedeSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  current: z.enum(["a", "b"]).nullable(),
});
const sortSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  area: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
interface TidySource {
  row: number;
  id: string;
  text: string;
  scope: string;
  effective_date: string;
  captured_at: string;
  checksum: string;
}
export interface TidyOptions {
  databasePath: string;
  areas: string[];
  area?: string;
  dryRun?: boolean;
  llm?: Llm;
  embeddingModel?: string;
}
export interface TidyRun {
  timestamp: string;
  durationMs: number;
  outcome: "completed" | "partial" | "failed";
  dryRun: boolean;
  areas: string[];
  llm: "configured" | "not_configured" | "unavailable";
  processor: "openai" | "codex";
  llmCalls: number;
  model: string | null;
  lastSuccessfulAt: string | null;
  sources: number;
  vectorsMissing: number;
  duplicates: number;
  supersedes: number;
  pairs: number;
  moved: number;
  uncertain: number;
  skipped: number;
  failures: number;
  capped: boolean;
  pairAfter: { area: string; row: number; priorRow: number } | null;
  windowEnd: string;
  inboxAfter: number | null;
  windowIncomplete: boolean;
}
async function previousRun(
  path: string,
  areas: string[],
  model: string | null,
  processor: string,
) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let previous: TidyRun | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as TidyRun;
        if (
          JSON.stringify(run.areas) === JSON.stringify(areas) &&
          run.model === model &&
          (run.processor ?? "openai") === processor &&
          !run.dryRun
        )
          previous = run;
      } catch {
        /* Ignore an interrupted final append; never interpret source content. */
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  return previous;
}
function normalize(text: string) {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ");
}
function cosine(a?: number[], b?: number[]) {
  if (!a || !b || a.length !== b.length) return -1;
  return a.reduce((n, v, i) => n + v * (b[i] ?? 0), 0);
}
function nearText(a: string, b: string) {
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.95)
    return false;
  const guards = (s: string) =>
    s
      .toLowerCase()
      .match(
        /\d+(?:[.,]\d+)*|\b(?:not|no|never|without)\b|(?<!\p{L})(?:не|нет|без)(?!\p{L})/gu,
      )
      ?.join(" ") ?? "";
  if (guards(a) !== guards(b)) return false;
  const words = (s: string) =>
    new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const aa = words(a),
    bb = words(b);
  return (
    [...aa].filter((w) => bb.has(w)).length / new Set([...aa, ...bb]).size >=
    0.95
  );
}
function vectors(db: DatabaseSync, scope: string, model: string) {
  const values = new Map<string, number[]>();
  for (const row of db
    .prepare(
      "SELECT record_id,vector FROM embedding_chunks WHERE scope=? AND kind='sources' AND model=? ORDER BY record_id,chunk",
    )
    .iterate(scope, model)) {
    if (!(row.vector instanceof Uint8Array) || row.vector.byteLength % 4)
      continue;
    const bytes = Buffer.from(row.vector);
    const vector =
      values.get(String(row.record_id)) ??
      Array<number>(bytes.length / 4).fill(0);
    if (vector.length * 4 !== bytes.length) continue;
    for (let i = 0; i < vector.length; i++)
      vector[i] = (vector[i] ?? 0) + bytes.readFloatLE(i * 4);
    values.set(String(row.record_id), vector);
  }
  for (const [id, value] of values) {
    const norm = Math.hypot(...value);
    if (!norm || !Number.isFinite(norm)) values.delete(id);
    else
      values.set(
        id,
        value.map((n) => n / norm),
      );
  }
  return values;
}

export async function runTidy(options: TidyOptions): Promise<TidyRun> {
  const areas = options.areas
    .filter((a) => !options.area || a === options.area)
    .sort();
  if (!areas.length || (options.area && !options.areas.includes(options.area)))
    throw new Error("Unknown tidy area");
  const directory = join(dirname(options.databasePath), "tidy");
  const history = join(directory, "history.jsonl");
  const model = options.llm?.model ?? null;
  const processor = options.llm?.processor ?? "openai";
  const previous = await previousRun(history, areas, model, processor);
  const timestamp = new Date().toISOString();
  const run: TidyRun = {
    timestamp,
    durationMs: 0,
    outcome: "completed",
    dryRun: !!options.dryRun,
    areas,
    llm: options.llm ? "configured" : "not_configured",
    model,
    processor,
    llmCalls: 0,
    inboxAfter: previous?.capped ? (previous.inboxAfter ?? null) : null,
    windowIncomplete: !!(
      previous?.capped &&
      (previous.windowIncomplete ||
        previous.failures ||
        previous.vectorsMissing)
    ),
    lastSuccessfulAt: previous?.lastSuccessfulAt ?? null,
    sources: 0,
    vectorsMissing: 0,
    duplicates: 0,
    supersedes: 0,
    pairs: 0,
    moved: 0,
    uncertain: 0,
    skipped: 0,
    failures: 0,
    capped: false,
    pairAfter: previous?.capped ? previous.pairAfter : null,
    windowEnd: previous?.capped ? previous.windowEnd : timestamp,
  };
  const unavailable = () => run.llm === "unavailable";
  const judgeBatch = async <T>(
    instruction: string,
    data: unknown[],
    schema: z.ZodType<T>,
  ) => {
    const answers = new Map<number, T>();
    if (!options.llm || unavailable() || run.llmCalls >= MAX_LLM_CALLS)
      return answers;
    run.llmCalls++;
    let raw: unknown[];
    try {
      const response = await options.llm.ask(instruction, data);
      if (!Array.isArray(response)) throw new Error("invalid_output");
      raw = response;
    } catch {
      run.failures++;
      run.llm = "unavailable";
      return answers;
    }
    for (let index = 0; index < data.length; index++) {
      const entries = raw.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "index" in entry &&
          entry.index === index,
      );
      const answer = schema.safeParse(
        entries.length === 1 ? entries[0] : undefined,
      );
      if (answer.success) answers.set(index, answer.data);
      else run.failures++;
    }
    return answers;
  };
  const start = performance.now();
  let knowledge: KnowledgeStore | undefined;
  let db: DatabaseSync | undefined;
  try {
    try {
      await options.llm?.preflight?.();
    } catch {
      run.llm = "unavailable";
      run.failures++;
    }
    knowledge = new KnowledgeStore(options.databasePath, {
      readOnly: !!options.dryRun,
    });
    db = new DatabaseSync(options.databasePath, {
      readOnly: !!options.dryRun,
      timeout: 5000,
    });
    const connection = db;
    const relations = new KnowledgeStore(connection);
    const plannedRelations = new Set<string>();
    const relation = (
      kind: "duplicates" | "supersedes",
      newer: TidySource,
      older: TidySource,
    ) => {
      plannedRelations.add(newer.id);
      plannedRelations.add(older.id);
      if (!options.dryRun) connection.exec("BEGIN IMMEDIATE");
      try {
        if (
          connection
            .prepare(
              "SELECT 1 FROM knowledge_relations WHERE scope=? AND kind=? AND from_id=? AND to_id=?",
            )
            .get(newer.scope, kind, newer.id, older.id)
        )
          return;
        // UNION visits every reachable ID once, including malformed cycles.
        // Check and write under the same lock so concurrent runs cannot close a cycle.
        if (
          kind === "duplicates" &&
          connection
            .prepare(`
        WITH RECURSIVE chain(id) AS (
          VALUES (?) UNION
          SELECT r.to_id FROM knowledge_relations r JOIN chain c ON r.from_id=c.id
          WHERE r.scope=? AND r.kind='duplicates'
        ) SELECT 1 FROM chain WHERE id=?
        LIMIT 1
      `)
            .get(older.id, newer.scope, newer.id)
        )
          return;
        if (!options.dryRun) {
          const saved = relations.relate({
            version: 1,
            scope: newer.scope,
            idempotencyKey: `tidy:${createHash("sha256")
              .update(JSON.stringify([kind, newer.id, older.id]))
              .digest("hex")}`,
            kind,
            fromId: newer.id,
            toId: older.id,
            sourceRefs: [{ sourceId: newer.id }, { sourceId: older.id }],
            creator:
              kind === "duplicates"
                ? { kind: "user", name: "context-tidy" }
                : { kind: "model", name: model ?? "context-tidy" },
          });
          if (saved.duplicate) return;
        }
        if (!options.dryRun) connection.exec("COMMIT");
        run[kind]++;
      } finally {
        if (connection.isTransaction) connection.exec("ROLLBACK");
      }
    };
    const cursor = run.pairAfter;
    for (const area of areas) {
      const sources = db
        .prepare(
          `SELECT s.rowid AS row,s.id,s.text,s.scope,s.captured_at,
            COALESCE(m.created_at,s.captured_at) AS effective_date,s.checksum
           FROM sources s LEFT JOIN source_metadata m ON m.source_id=s.id
           WHERE s.scope=? ORDER BY s.rowid`,
        )
        .all(area) as unknown as TidySource[];
      sources.sort(
        (a, b) =>
          Date.parse(a.effective_date) - Date.parse(b.effective_date) ||
          a.row - b.row,
      );
      run.sources += sources.length;
      const embeddings = vectors(
        db,
        area,
        options.embeddingModel ?? E5_VERSION,
      );
      const state = knowledge.retrievalRelations(area);
      const copies = new Set<string>();
      const normalized = new Map<string, TidySource>();
      const canonicals: TidySource[] = [];
      for (const [index, source] of sources.entries()) {
        if (index % 32 === 0) await yieldLoop();
        if (state.canonical(source.id) !== source.id) {
          copies.add(source.id);
          continue;
        }
        const text = normalize(source.text);
        if (text.length < MIN_DUPLICATE_LENGTH) continue;
        let canonical = normalized.get(text);
        if (!canonical)
          canonical = canonicals.find(
            (other) =>
              nearText(text, normalize(other.text)) &&
              cosine(embeddings.get(source.id), embeddings.get(other.id)) >=
                DUPLICATE_COSINE,
          );
        if (canonical) {
          relation("duplicates", source, canonical);
          copies.add(source.id);
        } else {
          normalized.set(text, source);
          canonicals.push(source);
        }
      }
      if (!options.llm || unavailable()) continue;
      run.vectorsMissing += sources.filter(
        (source) =>
          source.text.length <= MAX_FACT_LENGTH && !embeddings.has(source.id),
      ).length;
      const pending: { a: TidySource; b: TidySource }[] = [];
      const flushPairs = async () => {
        if (!pending.length) return;
        const answers = await judgeBatch(
          'For each indexed pair, which text explicitly replaces or updates the SAME statement in the other? Consider both effective dates. Different subjects, proposals, questions and mere related facts do not replace one another. Return a JSON array [{"index":0,"current":"a"|"b"|null},...]; null means no supersession.',
          pending.map(({ a, b }, index) => ({
            index,
            a: { text: a.text, effectiveDate: a.effective_date },
            b: { text: b.text, effectiveDate: b.effective_date },
          })),
          supersedeSchema,
        );
        for (const [index, answer] of answers) {
          const pair = pending[index];
          if (!pair || answer.current === null) continue;
          const [current, other] =
            answer.current === "a" ? [pair.a, pair.b] : [pair.b, pair.a];
          if (
            Date.parse(other.effective_date) -
              Date.parse(current.effective_date) >
            60_000
          ) {
            run.skipped++;
            continue;
          }
          relation("supersedes", current, other);
        }
        pending.length = 0;
      };
      // Resume by immutable row positions, not list offsets: another run may
      // move a source out of inbox while this capped window is unfinished.
      const pairSources = [...sources].sort((a, b) => a.row - b.row);
      for (const [i, laterRow] of pairSources.entries()) {
        if (i % 32 === 0) await yieldLoop();
        for (const priorRow of pairSources.slice(0, i)) {
          const a = laterRow,
            b = priorRow;
          const latestDate = Math.max(
            Date.parse(a.captured_at),
            Date.parse(b.captured_at),
          );
          if (
            [a, b].some(
              (source) =>
                source.text.length > MAX_FACT_LENGTH ||
                copies.has(source.id) ||
                state.canonical(source.id) !== source.id,
            ) ||
            latestDate > Date.parse(run.windowEnd) ||
            (run.lastSuccessfulAt &&
              latestDate < Date.parse(run.lastSuccessfulAt))
          )
            continue;
          if (
            cursor &&
            (area < cursor.area ||
              (area === cursor.area &&
                (laterRow.row < cursor.row ||
                  (laterRow.row === cursor.row &&
                    priorRow.row <= cursor.priorRow))))
          )
            continue;
          const similarity = cosine(embeddings.get(a.id), embeddings.get(b.id));
          if (similarity < SUPERSEDE_COSINE) continue;
          // High-cosine numeric changes rejected by the dedup guards remain candidates.
          if (unavailable()) continue;
          if (run.pairs >= MAX_PAIRS || run.llmCalls >= MAX_LLM_CALLS) {
            run.capped = true;
            continue;
          }
          run.pairs++;
          run.pairAfter = { area, row: laterRow.row, priorRow: priorRow.row };
          if (
            db
              .prepare(
                "SELECT 1 FROM knowledge_relations WHERE scope=? AND kind='supersedes' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",
              )
              .get(area, a.id, b.id, b.id, a.id)
          )
            continue;
          pending.push({ a, b });
          if (pending.length === BATCH_SIZE) await flushPairs();
        }
      }
      await flushPairs();
      if (area === "inbox") {
        const destinations = options.areas.filter(
          (a) => a !== "inbox" && safeDestination(connection, a),
        );
        const eligible = pairSources.filter((source) => {
          if (
            source.row <= (run.inboxAfter ?? 0) ||
            Date.parse(source.captured_at) > Date.parse(run.windowEnd)
          )
            return false;
          if (
            !destinations.length ||
            plannedRelations.has(source.id) ||
            copies.has(source.id) ||
            !movable(connection, source.id)
          ) {
            run.skipped++;
            return false;
          }
          return true;
        });
        for (let offset = 0; offset < eligible.length; offset += BATCH_SIZE) {
          if (unavailable()) break;
          if (run.llmCalls >= MAX_LLM_CALLS) {
            run.capped = true;
            break;
          }
          const batch = eligible.slice(offset, offset + BATCH_SIZE);
          const answers = await judgeBatch(
            'For each indexed source, choose a destination from areas only if it clearly belongs there. Return a JSON array [{"index":0,"area":"name"|null,"confidence":0.0},...]. When uncertain use null. Area is an access boundary, not just a topic.',
            batch.map((source, index) => ({
              index,
              areas: destinations,
              text: source.text,
            })),
            sortSchema,
          );
          run.inboxAfter = batch.at(-1)?.row ?? run.inboxAfter;
          for (const [index, answer] of answers) {
            const source = batch[index];
            if (!source) continue;
            if (
              !answer.area ||
              answer.confidence < 0.8 ||
              !destinations.includes(answer.area)
            ) {
              run.uncertain++;
              continue;
            }
            if (options.dryRun) run.moved++;
            else if (moveInbox(db, source.id, answer.area)) run.moved++;
            else run.skipped++;
          }
        }
      }
    }
    if (!run.capped) {
      run.pairAfter = null;
      run.inboxAfter = null;
    }
    // Finish capped work even if an earlier page had missing vectors/invalid
    // entries, then replay that incomplete window before advancing success.
    run.windowIncomplete ||= !!(run.failures || run.vectorsMissing);
    if (run.capped || run.windowIncomplete) run.outcome = "partial";
    else if (!options.dryRun) run.lastSuccessfulAt = run.windowEnd;
  } catch {
    run.outcome = "failed";
    run.failures++;
  } finally {
    db?.close();
    knowledge?.close();
  }
  run.durationMs = Math.round(performance.now() - start);
  if (!options.dryRun) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(history, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  }
  return run;
}
function hasTable(db: DatabaseSync, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
}
function movable(db: DatabaseSync, id: string) {
  if (
    db
      .prepare(
        "SELECT 1 FROM knowledge_items k,json_each(k.source_refs) ref WHERE json_extract(ref.value,'$.sourceId')=? LIMIT 1",
      )
      .get(id)
  )
    return false;
  if (
    db
      .prepare(
        "SELECT 1 FROM knowledge_relations r WHERE from_id=? OR to_id=? OR EXISTS (SELECT 1 FROM json_each(r.source_refs) ref WHERE json_extract(ref.value,'$.sourceId')=?) LIMIT 1",
      )
      .get(id, id, id)
  )
    return false;
  // Durable/in-flight processing output could otherwise recreate old-area knowledge.
  if (
    hasTable(db, "processing_jobs") &&
    db
      .prepare("SELECT 1 FROM processing_jobs WHERE source_id=? LIMIT 1")
      .get(id)
  )
    return false;
  return true;
}
function safeDestination(db: DatabaseSync, area: string) {
  // Existing client AND token grants are independent bounds. Do not broaden
  // disclosure for either, including refreshable tokens with narrower rights.
  for (const table of ["auth_clients", "auth_tokens"]) {
    if (!hasTable(db, table)) continue;
    if (
      db
        .prepare(`SELECT 1 FROM ${table} WHERE COALESCE(json_extract(data,'$.revoked'),0)=0
      AND EXISTS (SELECT 1 FROM json_each(data,'$.grants.read') WHERE value=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(data,'$.grants.read') WHERE value='inbox') LIMIT 1`)
        .get(area)
    )
      return false;
  }
  return true;
}
function moveInbox(db: DatabaseSync, id: string, area: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!movable(db, id) || !safeDestination(db, area)) {
      db.exec("ROLLBACK");
      return false;
    }
    const changed = db
      .prepare("UPDATE sources SET scope=? WHERE id=? AND scope='inbox'")
      .run(area, id).changes;
    if (!changed) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(
      "UPDATE embedding_chunks SET scope=? WHERE kind='sources' AND record_id=?",
    ).run(area, id);
    // Invalidate an active lease: its worker read the old area before this move.
    db.prepare(
      "UPDATE embedding_jobs SET scope=?,status='queued',lease=NULL,attempts=0,next_at=0,error=NULL WHERE kind='sources' AND record_id=?",
    ).run(area, id);
    // FTS/stemmed tables store only rowid/text; both join sources for area.
    // Capture/import identities retain their original request fingerprint. A
    // retry from the former area must fail closed, never recreate or disclose it.
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
