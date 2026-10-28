import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CaptureInput, captureSchema } from "./contracts.js";
import {
  type CaptureFileInput,
  type CaptureMaterialInput,
  captureFileSchema,
  captureMaterialSchema,
  decodeMaterialFile,
  type Material,
  type MaterialFile,
  type MaterialFileDescriptor,
  type MaterialMetadata,
} from "./materials.js";

import { ftsTerms, type PackageSelection } from "./package-query.js";

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

interface StoredMaterial {
  readonly metadata: MaterialMetadata;
  readonly file?: MaterialFileDescriptor & { readonly bytes: Buffer };
}

export interface MemoryPosition {
  readonly timestamp: number;
  readonly row: number;
}

export interface MemorySelection {
  readonly scope: string;
  readonly from?: string;
  readonly until?: string;
  readonly terms: readonly string[];
  readonly snapshot?: number;
  readonly after?: MemoryPosition;
  readonly limit: number;
}

function materialMetadata(
  input: CaptureMaterialInput["metadata"],
  type: MaterialMetadata["type"],
): MaterialMetadata {
  return {
    type,
    ...(input?.title !== undefined ? { title: input.title } : {}),
    ...(input?.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input?.sourceUri !== undefined ? { sourceUri: input.sourceUri } : {}),
  };
}

export class SourceStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    try {
      // Use the same ISO parser as input validation, including offsets SQLite's
      // date functions cannot parse. Original metadata remains untouched.
      this.#database.function(
        "source_timestamp",
        { deterministic: true },
        (value) => {
          if (typeof value !== "string") return null;
          const timestamp = Date.parse(value);
          return Number.isFinite(timestamp) ? timestamp : null;
        },
      );
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
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS source_metadata (
          source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
          type TEXT NOT NULL CHECK(type IN ('note', 'document')),
          title TEXT,
          created_at TEXT,
          source_uri TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS source_files (
          source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK(media_type IN ('text/plain', 'text/markdown')),
          byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16384),
          checksum TEXT NOT NULL CHECK(length(checksum) = 64),
          original BLOB NOT NULL CHECK(length(original) = byte_length)
        ) STRICT;
        COMMIT;
      `);
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
    return this.#capture(request, fingerprint);
  }

  captureMaterial(input: CaptureMaterialInput): {
    material: Material;
    duplicate: boolean;
  } {
    const request = captureMaterialSchema.parse(input);
    const metadata = materialMetadata(
      request.metadata,
      request.metadata?.type ?? "note",
    );
    const fingerprint = this.#materialFingerprint(
      "material",
      request,
      metadata,
    );
    const saved = this.#capture(request, fingerprint, { metadata });
    const material = this.findMaterial(saved.source.id, request.scope);
    if (!material) throw new Error("Missing saved material");
    return { material, duplicate: saved.duplicate };
  }

  captureFile(input: CaptureFileInput): {
    material: Material;
    duplicate: boolean;
  } {
    const request = captureFileSchema.parse(input);
    const { bytes, text } = decodeMaterialFile(request.contentBase64);
    const metadata = materialMetadata(request.metadata, "document");
    const file = {
      bytes,
      filename: request.filename,
      mediaType: request.mediaType,
      byteLength: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    };
    const sourceRequest = { ...request, text };
    const fingerprint = this.#materialFingerprint(
      "file",
      sourceRequest,
      metadata,
      [file.filename, file.mediaType, request.contentBase64],
    );
    const saved = this.#capture(sourceRequest, fingerprint, { metadata, file });
    const material = this.findMaterial(saved.source.id, request.scope);
    if (!material) throw new Error("Missing saved material");
    return { material, duplicate: saved.duplicate };
  }

  #materialFingerprint(
    kind: "material" | "file",
    request: Pick<CaptureInput, "version" | "text" | "origin" | "scope">,
    metadata: MaterialMetadata,
    file: readonly string[] = [],
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          kind,
          request.version,
          request.text,
          request.origin,
          request.scope,
          metadata.type,
          metadata.title ?? null,
          metadata.createdAt ?? null,
          metadata.sourceUri ?? null,
          ...file,
        ]),
      )
      .digest("hex");
  }

  #capture(
    request: Pick<CaptureInput, "text" | "origin" | "scope" | "idempotencyKey">,
    fingerprint: string,
    material?: StoredMaterial,
  ): { source: Source; duplicate: boolean } {
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
      if (material) {
        const metadata = material.metadata;
        this.#database
          .prepare(`
            INSERT INTO source_metadata (source_id, type, title, created_at, source_uri)
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            source.id,
            metadata.type,
            metadata.title ?? null,
            metadata.createdAt ?? null,
            metadata.sourceUri ?? null,
          );
        if (material.file) {
          const file = material.file;
          this.#database
            .prepare(`
              INSERT INTO source_files
                (source_id, filename, media_type, byte_length, checksum, original)
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            .run(
              source.id,
              file.filename,
              file.mediaType,
              file.byteLength,
              file.checksum,
              file.bytes,
            );
        }
      }
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

  findMaterial(id: string, scope: string): Material | undefined {
    const source = this.find(id, scope);
    if (!source) return undefined;
    const row = this.#database
      .prepare(`
        SELECT type, title, created_at AS createdAt, source_uri AS sourceUri
        FROM source_metadata WHERE source_id = ?
      `)
      .get(id);
    const metadata: MaterialMetadata = row
      ? {
          type: row.type as MaterialMetadata["type"],
          ...(row.title !== null ? { title: String(row.title) } : {}),
          ...(row.createdAt !== null
            ? { createdAt: String(row.createdAt) }
            : {}),
          ...(row.sourceUri !== null
            ? { sourceUri: String(row.sourceUri) }
            : {}),
        }
      : { type: "note" };
    const file = this.#fileDescriptor(id);
    return { source, metadata, ...(file ? { file } : {}) };
  }

  #fileDescriptor(id: string): MaterialFileDescriptor | undefined {
    const row = this.#database
      .prepare(`
        SELECT filename, media_type AS mediaType, byte_length AS byteLength, checksum
        FROM source_files WHERE source_id = ?
      `)
      .get(id);
    return row ? ({ ...row } as unknown as MaterialFileDescriptor) : undefined;
  }

  readMaterialFile(id: string, scope: string): MaterialFile | undefined {
    if (!this.find(id, scope)) return undefined;
    const file = this.#fileDescriptor(id);
    if (!file) return undefined;
    const row = this.#database
      .prepare("SELECT original FROM source_files WHERE source_id = ?")
      .get(id);
    if (!(row?.original instanceof Uint8Array)) {
      throw new Error("Missing original material bytes");
    }
    const bytes = Buffer.from(row.original);
    if (
      bytes.length !== file.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== file.checksum
    ) {
      throw new Error("Material file integrity check failed");
    }
    return { ...file, contentBase64: bytes.toString("base64") };
  }

  list(scope: string, limit = 20): Source[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("Limit must be an integer between 1 and 20");
    }
    return this.#database
      .prepare(`
        SELECT id, text, origin, scope, captured_at AS capturedAt, checksum, status
        FROM sources WHERE scope = ? ORDER BY captured_at DESC, id LIMIT ?
      `)
      .all(scope, limit)
      .map((row) => ({ ...row }) as unknown as Source);
  }

  // The rowid watermark excludes later arrivals, including backdated notes.
  // Compare source dates and filters using the same UTC millisecond semantics.
  selectMemory(input: MemorySelection) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 51)
      throw new Error("Invalid memory selection limit");
    const snapshot =
      input.snapshot ??
      Number(
        this.#database
          .prepare(
            "SELECT COALESCE(MAX(rowid), 0) AS watermark FROM sources WHERE scope = ?",
          )
          .get(input.scope)?.watermark,
      );
    const date = "source_timestamp(COALESCE(m.created_at, s.captured_at))";
    const conditions = ["s.scope = ?", "s.rowid <= ?"];
    const params: (string | number)[] = [input.scope, snapshot];
    if (input.from !== undefined) {
      conditions.push(`${date} >= ?`);
      params.push(Date.parse(input.from));
    }
    if (input.until !== undefined) {
      conditions.push(`${date} < ?`);
      params.push(Date.parse(input.until));
    }
    if (input.terms.length) {
      conditions.push(
        "s.rowid IN (SELECT rowid FROM sources_fts WHERE sources_fts MATCH ?)",
      );
      params.push(
        input.terms
          .map((term) => `"${term.replaceAll('"', '""')}"`)
          .join(" OR "),
      );
    }
    const from =
      "FROM sources s LEFT JOIN source_metadata m ON m.source_id = s.id";
    const total = Number(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS total ${from} WHERE ${conditions.join(" AND ")}`,
        )
        .get(...params)?.total,
    );
    if (input.after) {
      conditions.push(`(${date} < ? OR (${date} = ? AND s.rowid < ?))`);
      params.push(
        input.after.timestamp,
        input.after.timestamp,
        input.after.row,
      );
    }
    const rows = this.#database
      .prepare(
        `SELECT s.id, s.rowid AS row, ${date} AS timestamp ${from}
       WHERE ${conditions.join(" AND ")} ORDER BY ${date} DESC, s.rowid DESC LIMIT ?`,
      )
      .all(...params, input.limit);
    return {
      snapshot,
      total,
      entries: rows.map((row) => {
        const material = this.findMaterial(String(row.id), input.scope);
        if (
          !material ||
          typeof row.timestamp !== "number" ||
          typeof row.row !== "number"
        )
          throw new Error("Invalid stored memory source");
        return {
          material,
          position: { timestamp: row.timestamp, row: row.row },
        };
      }),
    };
  }

  // SQL selects bounded candidates; full originals never leave this layer by default.
  packageCandidates(input: PackageSelection) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101)
      throw new Error("Invalid candidate bound");
    const date = "source_timestamp(COALESCE(m.created_at, s.captured_at))";
    const conditions = ["s.scope = ?"];
    const params: (string | number)[] = [input.scope];
    if (input.from) {
      conditions.push(`${date} >= ?`);
      params.push(Date.parse(input.from));
    }
    if (input.until) {
      conditions.push(`${date} < ?`);
      params.push(Date.parse(input.until));
    }
    const match = input.terms.length > 0;
    if (match) {
      conditions.push("sources_fts MATCH ?");
      params.push(ftsTerms(input.terms));
    }
    const from = `FROM sources s LEFT JOIN source_metadata m ON m.source_id = s.id ${match ? "JOIN sources_fts ON sources_fts.rowid = s.rowid" : ""}`;
    const where = conditions.join(" AND ");
    const total = Number(
      this.#database
        .prepare(`SELECT COUNT(*) n ${from} WHERE ${where}`)
        .get(...params)?.n,
    );
    const rows = this.#database
      .prepare(
        `SELECT s.id ${from} WHERE ${where} ORDER BY ${match ? "sources_fts.rank," : ""} ${date} DESC, s.id LIMIT ?`,
      )
      .all(...params, input.limit);
    return {
      total,
      materials: rows.map((row) => {
        const material = this.findMaterial(String(row.id), input.scope);
        if (!material) throw new Error("Missing source candidate");
        return material;
      }),
    };
  }

  checkHealth(): void {
    this.#database.prepare("SELECT 1 FROM sources LIMIT 1").get();
  }

  close(): void {
    this.#database.close();
  }
}
