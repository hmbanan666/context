import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CaptureInput, captureSchema } from "./contracts.js";

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

export class IdempotencyConflict extends Error {}

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
      const version = this.#database
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (version !== 0 && version !== 1)
        throw new Error("Unsupported database version");
      if (version === 0) {
        this.#database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE capture_requests (
            scope TEXT NOT NULL,
            request_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            source_id TEXT NOT NULL REFERENCES sources(id),
            PRIMARY KEY (scope, request_key)
          ) STRICT;
          CREATE VIRTUAL TABLE sources_fts USING fts5(
            text, content='sources', content_rowid='rowid'
          );
          CREATE TRIGGER sources_insert AFTER INSERT ON sources BEGIN
            INSERT INTO sources_fts(rowid, text) VALUES (new.rowid, new.text);
          END;
          INSERT INTO sources_fts(sources_fts) VALUES ('rebuild');
          PRAGMA user_version = 1;
          COMMIT;
        `);
      }
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  capture(input: CaptureInput): { source: Source; duplicate: boolean } {
    const request = captureSchema.parse(input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          request.version,
          request.text,
          request.origin,
          request.scope,
        ]),
      )
      .digest("hex");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare(`
        SELECT fingerprint, source_id FROM capture_requests WHERE scope = ? AND request_key = ?
      `)
        .get(request.scope, request.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new IdempotencyConflict(
            "Idempotency key reused with different input",
          );
        }
        const source = this.find(String(existing.source_id), request.scope);
        if (!source) throw new Error("Missing idempotent source");
        this.#database.exec("COMMIT");
        return { source, duplicate: true };
      }
      const source = this.insert({
        id: randomUUID(),
        text: request.text,
        origin: request.origin,
        scope: request.scope,
        capturedAt: new Date().toISOString(),
      });
      this.#database
        .prepare(`
        INSERT INTO capture_requests (scope, request_key, fingerprint, source_id) VALUES (?, ?, ?, ?)
      `)
        .run(request.scope, request.idempotencyKey, fingerprint, source.id);
      this.#database.exec("COMMIT");
      return { source, duplicate: false };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string, scope: string, limit: number): Source[] {
    // Treat user input as a literal FTS phrase, never as FTS operators.
    const phrase = `"${query.replaceAll('"', '""')}"`;
    const rows = this.#database
      .prepare(`
      SELECT s.id, s.text, s.origin, s.scope, s.captured_at AS capturedAt, s.checksum, s.status
      FROM sources_fts JOIN sources s ON s.rowid = sources_fts.rowid
      WHERE sources_fts MATCH ? AND s.scope = ?
      ORDER BY sources_fts.rank, s.id LIMIT ?
    `)
      .all(phrase, scope, limit);
    return rows.map((row) => ({ ...row }) as unknown as Source);
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
