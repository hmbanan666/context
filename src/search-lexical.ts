import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newStemmer } from "snowball-stemmers-js";
import { ftsMatchOffset, ftsTerms } from "./package-query.js";
import { visibleSourceText } from "./source-text.js";

const english = newStemmer("english");
const russian = newStemmer("russian");
const VECTOR_RRF_WEIGHT = 5;
// Below either original lexical list (weight 1). See lexicalCandidates.
export const EXPANSION_RRF_WEIGHT = 0.35;
const ORIGINAL_MATCH_BAND = 2;
const MULTI_EXPANSION_BAND = 1;
export function stemText(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((word) =>
      /^[а-яё]+$/u.test(word)
        ? russian.stemWord(word)
        : /^[a-z]+$/.test(word)
          ? english.stemWord(word)
          : word,
    )
    .join(" ");
}
export type SearchTable = "sources" | "knowledge_items";
export interface VectorHit {
  id: string;
  offset: number;
}
export interface TermHit {
  original: boolean;
  concepts: number;
}

const searchFunctions = new WeakSet<DatabaseSync>();
export function registerSearchFunctions(db: DatabaseSync): void {
  if (searchFunctions.has(db)) return;
  searchFunctions.add(db);
  db.function("context_stem", { deterministic: true }, (value) =>
    stemText(String(value ?? "")),
  );
  db.function("context_visible_text", { deterministic: true }, (value) =>
    visibleSourceText(typeof value === "string" ? value : ""),
  );
}

// Only derived data is migrated. Every writer registers the deterministic scalar
// function; SQLite itself still uses the built-in unicode61 FTS5 tokenizer.
export function installSearchIndex(db: DatabaseSync, table: SearchTable) {
  registerSearchFunctions(db);
  const indexed = table === "sources" ? "context_visible_text(text)" : "text";
  const indexedNew =
    table === "sources" ? "context_visible_text(new.text)" : "new.text";
  db.exec(`CREATE TABLE IF NOT EXISTS embedding_jobs (
    kind TEXT NOT NULL, record_id TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, lease TEXT, error TEXT,
    PRIMARY KEY(kind, record_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS embedding_jobs_pending ON embedding_jobs(status, next_at);
  CREATE INDEX IF NOT EXISTS embedding_jobs_area ON embedding_jobs(scope, status);
  CREATE TABLE IF NOT EXISTS embedding_chunks (
    kind TEXT NOT NULL, record_id TEXT NOT NULL, scope TEXT NOT NULL,
    chunk INTEGER NOT NULL, offset INTEGER NOT NULL, model TEXT NOT NULL,
    vector BLOB NOT NULL, PRIMARY KEY(kind, record_id, chunk)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS embedding_chunks_area ON embedding_chunks(scope,kind,model);`);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE name=?")
        .get(`${table}_stemmed`)
    ) {
      db.exec(`CREATE VIRTUAL TABLE ${table}_stemmed USING fts5(text);
        INSERT INTO ${table}_stemmed(rowid,text) SELECT rowid,context_stem(${indexed}) FROM ${table};
        INSERT OR IGNORE INTO embedding_jobs(kind,record_id,scope) SELECT '${table}',id,scope FROM ${table};
        CREATE TRIGGER ${table}_search_insert AFTER INSERT ON ${table} BEGIN
          INSERT INTO ${table}_stemmed(rowid,text) VALUES(new.rowid,context_stem(${indexedNew}));
          INSERT OR IGNORE INTO embedding_jobs(kind,record_id,scope) VALUES('${table}',new.id,new.scope);
        END;
        CREATE TRIGGER ${table}_search_delete AFTER DELETE ON ${table} BEGIN
          DELETE FROM ${table}_stemmed WHERE rowid=old.rowid;
          DELETE FROM embedding_chunks WHERE kind='${table}' AND record_id=old.id;
          DELETE FROM embedding_jobs WHERE kind='${table}' AND record_id=old.id;
        END;`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const footerSource = `
  instr(text, 'CURSOR_AGENT_PR_BODY') > 0
  OR instr(text, 'Open in Cursor') > 0
  OR instr(text, 'Open in Web') > 0`;

// Bump when visibleSourceText changes so an already-migrated database rebuilds
// the derived source index once. Sources stay put.
export const VISIBLE_TEXT_VERSION = "2";

function storedVisibleTextVersion(db: DatabaseSync): string | null {
  const table = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'derived_index_meta'",
    )
    .get();
  if (!table) return null;
  const row = db
    .prepare("SELECT value FROM derived_index_meta WHERE key = 'visible_text'")
    .get() as { value?: string } | undefined;
  return row?.value ?? null;
}

// Existing databases indexed the immutable source, including Cursor PR footers.
// Rebuild the derived source index from the visible text once per version.
export function ensureVisibleSourceIndex(db: DatabaseSync): void {
  registerSearchFunctions(db);
  const schema = (name: string) =>
    String(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)
        ?.sql ?? "",
    );
  const fts = schema("sources_fts");
  if (
    storedVisibleTextVersion(db) === VISIBLE_TEXT_VERSION &&
    fts &&
    !/content\s*=/iu.test(fts) &&
    schema("sources_insert").includes("context_visible_text") &&
    schema("sources_search_insert").includes("context_visible_text")
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS sources_insert;
      DROP TABLE IF EXISTS sources_fts;
      CREATE VIRTUAL TABLE sources_fts USING fts5(text);
      INSERT INTO sources_fts(rowid, text)
        SELECT rowid, context_visible_text(text) FROM sources;
      CREATE TRIGGER sources_insert AFTER INSERT ON sources BEGIN
        INSERT INTO sources_fts(rowid, text)
          VALUES (new.rowid, context_visible_text(new.text));
      END;
      DROP TRIGGER IF EXISTS sources_search_insert;
      CREATE TRIGGER sources_search_insert AFTER INSERT ON sources BEGIN
        INSERT INTO sources_stemmed(rowid, text)
          VALUES (new.rowid, context_stem(context_visible_text(new.text)));
        INSERT OR IGNORE INTO embedding_jobs(kind, record_id, scope)
          VALUES ('sources', new.id, new.scope);
      END;
      DELETE FROM sources_stemmed;
      INSERT INTO sources_stemmed(rowid, text)
        SELECT rowid, context_stem(context_visible_text(text)) FROM sources;
      INSERT OR IGNORE INTO embedding_jobs(kind, record_id, scope)
        SELECT 'sources', id, scope FROM sources WHERE ${footerSource};
      UPDATE embedding_jobs
        SET status = 'queued', attempts = 0, next_at = 0, lease = NULL, error = NULL
        WHERE kind = 'sources' AND record_id IN (
          SELECT id FROM sources WHERE ${footerSource}
        );
      DELETE FROM embedding_chunks
        WHERE kind = 'sources' AND record_id IN (
          SELECT id FROM sources WHERE ${footerSource}
        );
      CREATE TABLE IF NOT EXISTS derived_index_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO derived_index_meta (key, value)
        VALUES ('visible_text', '${VISIBLE_TEXT_VERSION}')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function stemOffset(text: string, terms: readonly string[]): number {
  const wanted = new Set(terms.map(stemText));
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (wanted.has(stemText(match[0]))) return match.index;
  }
  return 0;
}

// Each list has already passed area, date and provenance predicates before
// receiving a rank. RRF never compares BM25 magnitudes across indexes.
// Without explicit weights, lists are exact, stemmed, vector.
export function reciprocalRankScores(
  lists: readonly (readonly string[])[],
  weights?: readonly number[],
) {
  const scores = new Map<string, number>();
  for (const [index, list] of lists.entries()) {
    const weight = weights?.[index] ?? (index === 2 ? VECTOR_RRF_WEIGHT : 1);
    for (const [rank, id] of [...new Set(list)].entries()) {
      scores.set(id, (scores.get(id) ?? 0) + weight / (60 + rank + 1));
    }
  }
  return scores;
}

export function reciprocalRanks(lists: readonly (readonly string[])[]) {
  return [...reciprocalRankScores(lists)]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

export function lexicalCandidates(
  db: DatabaseSync,
  table: SearchTable,
  eligible: string,
  params: SQLInputValue[],
  terms: readonly string[],
  limit: number,
  vectors: readonly VectorHit[] = [],
  expansion: readonly string[] = [],
) {
  const exact = `${table}_fts`,
    stemmed = `${table}_stemmed`;
  const offsets = new Map<string, number>();
  const lists: string[][] = [];
  const weights: number[] = [];
  const matched = (
    index: string,
    queryTerms: readonly string[],
    highlighted: boolean,
    stemNeedles: readonly string[],
  ) => {
    const rows = db
      .prepare(`WITH eligible AS (${eligible})
      SELECT e.id,e.text,${highlighted ? `highlight(${index},0,' ','')` : "NULL"} highlighted
      FROM ${index} JOIN eligible e ON e.rowid=${index}.rowid
      WHERE ${index} MATCH ? ORDER BY ${index}.rank,e.id LIMIT ?`)
      .all(...params, ftsTerms(queryTerms), limit);
    return rows.map((row) => {
      const id = String(row.id);
      const comparable =
        table === "sources"
          ? visibleSourceText(String(row.text))
          : String(row.text);
      if (!offsets.has(id))
        offsets.set(
          id,
          highlighted
            ? ftsMatchOffset(comparable, row.highlighted)
            : stemOffset(comparable, stemNeedles),
        );
      return id;
    });
  };
  const push = (ids: string[], weight: number) => {
    lists.push(ids);
    weights.push(weight);
  };
  // Original tokens outrank glossary synonyms. Each synonym concept is its own
  // lower-weight list, grouped by stem so distill/distillation count once.
  const exactOriginal = matched(exact, terms, true, terms);
  push(exactOriginal, 1);
  const originalStems = matched(stemmed, terms.map(stemText), false, terms);
  push(originalStems, 1);
  const originalIds = new Set([...exactOriginal, ...originalStems]);
  const conceptCounts = new Map<string, number>();
  const groups = new Map<string, string[]>();
  for (const term of expansion) {
    const key = stemText(term);
    const surfaces = groups.get(key);
    if (surfaces) surfaces.push(term);
    else groups.set(key, [term]);
  }
  for (const surfaces of groups.values()) {
    const exactIds = matched(exact, surfaces, true, surfaces);
    const stemIds = matched(
      stemmed,
      [stemText(surfaces[0] ?? "")],
      false,
      surfaces,
    );
    push(exactIds, EXPANSION_RRF_WEIGHT);
    push(stemIds, EXPANSION_RRF_WEIGHT);
    for (const id of new Set([...exactIds, ...stemIds]))
      conceptCounts.set(id, (conceptCounts.get(id) ?? 0) + 1);
  }
  if (vectors.length > 101) throw new Error("Invalid vector candidate bound");
  const placeholders = vectors.map(() => "?").join(",");
  const vectorIds = vectors.map((hit) => hit.id);
  const validVectors = vectors.length
    ? new Set(
        db
          .prepare(`SELECT id FROM (${eligible}) WHERE id IN (${placeholders})`)
          .all(...params, ...vectorIds)
          .map((row) => String(row.id)),
      )
    : new Set<string>();
  push(
    vectors
      .filter((hit) => validVectors.has(hit.id))
      .map((hit) => {
        if (!offsets.has(hit.id)) offsets.set(hit.id, hit.offset);
        return hit.id;
      }),
    VECTOR_RRF_WEIGHT,
  );
  const lexicalTerms = [...new Set([...terms, ...expansion])];
  const queries = [
    ftsTerms(lexicalTerms),
    ftsTerms(lexicalTerms.map(stemText)),
  ];
  const total = Number(
    db
      .prepare(`WITH eligible AS (${eligible}) SELECT COUNT(*) n FROM eligible e WHERE
    e.rowid IN (SELECT rowid FROM ${exact} WHERE ${exact} MATCH ? UNION SELECT rowid FROM ${stemmed} WHERE ${stemmed} MATCH ?)
    ${vectors.length ? `OR e.id IN (${placeholders})` : ""}`)
      .get(...params, ...queries, ...vectorIds)?.n,
  );
  const scores = reciprocalRankScores(lists, weights);
  // Bands apply only when a glossary actually expanded the query, so ordinary
  // hybrid search keeps vector weight 5. An original-term hit stays above every
  // synonym hit. Two or more synonym concepts stay above a vector neighbour
  // that matched only one of them (the nightly-backup vs distillation case).
  // A single synonym stays on the RRF scale and cannot flood past the original.
  if (expansion.length) {
    for (const [id, score] of scores) {
      const band = originalIds.has(id)
        ? ORIGINAL_MATCH_BAND
        : (conceptCounts.get(id) ?? 0) >= 2
          ? MULTI_EXPANSION_BAND
          : 0;
      scores.set(id, score + band);
    }
  }
  const termHits = new Map<string, TermHit>();
  for (const id of scores.keys())
    termHits.set(id, {
      original: originalIds.has(id),
      concepts: conceptCounts.get(id) ?? 0,
    });
  return {
    total,
    ids: [...scores]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => id),
    matchOffsets: offsets,
    scores,
    termHits,
  };
}
