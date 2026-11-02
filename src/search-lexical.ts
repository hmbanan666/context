import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { newStemmer } from "snowball-stemmers-js";
import { ftsMatchOffset, ftsTerms } from "./package-query.js";

const english = newStemmer("english");
const russian = newStemmer("russian");
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

// Only derived data is migrated. Every writer registers the deterministic scalar
// function; SQLite itself still uses the built-in unicode61 FTS5 tokenizer.
export function installSearchIndex(db: DatabaseSync, table: SearchTable) {
  db.function("context_stem", { deterministic: true }, (value) =>
    stemText(String(value)),
  );
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
        INSERT INTO ${table}_stemmed(rowid,text) SELECT rowid,context_stem(text) FROM ${table};
        INSERT OR IGNORE INTO embedding_jobs(kind,record_id,scope) SELECT '${table}',id,scope FROM ${table};
        CREATE TRIGGER ${table}_search_insert AFTER INSERT ON ${table} BEGIN
          INSERT INTO ${table}_stemmed(rowid,text) VALUES(new.rowid,context_stem(new.text));
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

export function stemOffset(text: string, terms: readonly string[]): number {
  const wanted = new Set(terms.map(stemText));
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (wanted.has(stemText(match[0]))) return match.index;
  }
  return 0;
}

// Each list has already passed area, date and provenance predicates before
// receiving a rank. RRF never compares BM25 magnitudes across indexes.
export function reciprocalRanks(lists: readonly (readonly string[])[]) {
  const scores = new Map<string, number>();
  for (const list of lists)
    for (const [rank, id] of [...new Set(list)].entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1));
    }
  return [...scores]
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
) {
  const exact = `${table}_fts`,
    stemmed = `${table}_stemmed`;
  const queries = [ftsTerms(terms), ftsTerms(terms.map(stemText))];
  const offsets = new Map<string, number>();
  const lists = [exact, stemmed].map((index, i) => {
    const rows = db
      .prepare(`WITH eligible AS (${eligible})
      SELECT e.id,e.text,${i === 0 ? `highlight(${index},0,' ','')` : "NULL"} highlighted
      FROM ${index} JOIN eligible e ON e.rowid=${index}.rowid
      WHERE ${index} MATCH ? ORDER BY ${index}.rank,e.id LIMIT ?`)
      .all(...params, queries[i] ?? "", limit);
    return rows.map((row) => {
      const id = String(row.id);
      if (!offsets.has(id))
        offsets.set(
          id,
          i === 0
            ? ftsMatchOffset(String(row.text), row.highlighted)
            : stemOffset(String(row.text), terms),
        );
      return id;
    });
  });
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
  lists.push(
    vectors
      .filter((hit) => validVectors.has(hit.id))
      .map((hit) => {
        if (!offsets.has(hit.id)) offsets.set(hit.id, hit.offset);
        return hit.id;
      }),
  );
  const total = Number(
    db
      .prepare(`WITH eligible AS (${eligible}) SELECT COUNT(*) n FROM eligible e WHERE
    e.rowid IN (SELECT rowid FROM ${exact} WHERE ${exact} MATCH ? UNION SELECT rowid FROM ${stemmed} WHERE ${stemmed} MATCH ?)
    ${vectors.length ? `OR e.id IN (${placeholders})` : ""}`)
      .get(...params, ...queries, ...vectorIds)?.n,
  );
  return {
    total,
    ids: reciprocalRanks(lists).slice(0, limit),
    matchOffsets: offsets,
  };
}
