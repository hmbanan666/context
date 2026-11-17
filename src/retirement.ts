import type { DatabaseSync } from "node:sqlite";

/** SQL that keeps a source in search and read. The column is a fixed identifier. */
export function notRetired(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column))
    throw new Error("Invalid column");
  return `NOT EXISTS (SELECT 1 FROM source_retirements r WHERE r.source_id = ${column})`;
}

/**
 * On a database that has not been opened for write since retirements shipped,
 * every source is still active. Callers can append the result as a condition.
 */
export function retirementFilter(db: DatabaseSync, column: string): string {
  const ready = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'source_retirements'",
    )
    .get();
  return ready ? notRetired(column) : "1";
}
