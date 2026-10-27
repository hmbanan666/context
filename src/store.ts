import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SourceInput {
  readonly id: string;
  readonly text: string;
  readonly origin: string;
  readonly scope: string;
  readonly capturedAt: string;
}

export interface Source extends SourceInput {
  readonly checksum: string;
  readonly status: "unreviewed";
}

// Internal persistence only. No HTTP or MCP caller can invoke this store yet.
export class SourceStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
          text TEXT NOT NULL CHECK(length(text) > 0),
          origin TEXT NOT NULL CHECK(length(origin) > 0),
          scope TEXT NOT NULL CHECK(length(scope) > 0),
          captured_at TEXT NOT NULL,
          checksum TEXT NOT NULL CHECK(length(checksum) = 64),
          status TEXT NOT NULL CHECK(status = 'unreviewed')
        ) STRICT;
      `);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  insert(source: SourceInput): Source {
    if (
      [source.id, source.text, source.origin, source.scope].some(
        (value) => !value.trim(),
      ) ||
      !Number.isFinite(Date.parse(source.capturedAt))
    ) {
      throw new Error("Invalid source metadata");
    }
    const record: Source = {
      ...source,
      checksum: createHash("sha256").update(source.text, "utf8").digest("hex"),
      status: "unreviewed",
    };
    this.#database
      .prepare(`
        INSERT INTO sources (id, text, origin, scope, captured_at, checksum, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.text,
        record.origin,
        record.scope,
        record.capturedAt,
        record.checksum,
        record.status,
      );
    return record;
  }

  find(id: string, scope: string): Source | undefined {
    const row = this.#database
      .prepare(`
        SELECT id, text, origin, scope, captured_at AS capturedAt, checksum, status
        FROM sources WHERE id = ? AND scope = ?
      `)
      .get(id, scope);
    if (!row) return undefined;
    return { ...row } as unknown as Source;
  }

  checkHealth(): void {
    this.#database.prepare("SELECT 1 FROM sources LIMIT 1").get();
  }

  close(): void {
    this.#database.close();
  }
}
