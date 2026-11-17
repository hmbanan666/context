import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CaptureInput, captureSchema } from "./contracts.js";
import {
  adjustDocumentScore,
  currentDocumentSourceSql,
  type DocumentInput,
  type DocumentRef,
  type DocumentRevisionSummary,
  type DocumentWrite,
  documentRefCandidates,
  installDocuments,
  parseDocument,
  type SourceDocument,
  staleDocumentSourceSql,
} from "./documents.js";
import {
  builtinGlossary,
  expandQueryTerms,
  mergeGlossary,
  type GlossaryEntry,
} from "./glossary.js";
import type { ImportProvenance } from "./import-format.js";
import {
  KnowledgeNotFound,
  KnowledgeStore,
  knowledgeCreatorSchema,
  knowledgeMatchStatusSql,
  supersedesSchema,
} from "./knowledge.js";
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
import {
  addClientAssociation,
  associationsFor,
  backfillProjects,
  clearProjectProfile,
  createProject,
  listProjectGlossary,
  setProjectGlossaryTerm,
  unsetProjectGlossaryTerm,
  type ProjectGlossaryEntry,
  getProjectProfile,
  findProject,
  hasProject,
  projectIdentityWords,
  installProjects,
  isLinkedToProject,
  linkClientProjects,
  canonicalRepositoryMetadata,
  linkConfiguredImport,
  linkedProjectSql,
  listProjects,
  listVisibleProjects,
  mapRepository,
  type ProjectProfile,
  proposeProjectLink,
  readProjectProfile,
  rememberProjectsSchema,
  renameProject,
  setProjectProfile,
  repositoryMappings,
  unmapRepository,
  type Project,
  type ProjectAssociation,
  type ProjectBackfill,
  type ProjectRecordKind,
  type RepositoryMapping,
} from "./projects.js";
import { redact, redactFields } from "./redaction.js";
import { notRetired } from "./retirement.js";
import { retrievalRelations } from "./retrieval-relations.js";
import {
  ensureVisibleSourceIndex,
  installSearchIndex,
  lexicalCandidates,
  registerSearchFunctions,
  stemText,
  type ExpandedTerm,
  type TermHit,
} from "./search-lexical.js";

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
  readonly supersededBy?: string;
}

export class IdempotencyConflict extends Error {}

interface CaptureSupersession {
  ids: string[];
  clientId: string;
}

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
  readonly projectId?: string;
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
  #retirementReady = false;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(path, {
      timeout: 5000,
      readOnly: options.readOnly ?? false,
    });
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
      if (options.readOnly) {
        this.#retirementReady = this.#hasRetirementTable();
        return;
      }
      registerSearchFunctions(this.#database);
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
          CREATE VIRTUAL TABLE sources_fts USING fts5(text);
          CREATE TRIGGER sources_insert AFTER INSERT ON sources BEGIN
            INSERT INTO sources_fts(rowid, text)
              VALUES (new.rowid, context_visible_text(new.text));
          END;
          INSERT INTO sources_fts(rowid, text)
            SELECT rowid, context_visible_text(text) FROM sources;
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
        CREATE TABLE IF NOT EXISTS source_imports (
          source TEXT NOT NULL,
          external_id TEXT NOT NULL,
          source_id TEXT NOT NULL REFERENCES sources(id),
          fingerprint TEXT NOT NULL,
          provenance TEXT NOT NULL,
          PRIMARY KEY (source, external_id, fingerprint)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS source_imports_source_id ON source_imports(source_id);
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
      installProjects(this.#database);
      installDocuments(this.#database);
      this.#installRetirement();
      installSearchIndex(this.#database, "sources");
      ensureVisibleSourceIndex(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  capture(input: CaptureInput): { source: Source; duplicate: boolean } {
    const request = captureSchema.parse(
      redactFields(captureSchema.parse(input)),
    );
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

  captureMaterial(
    input: CaptureMaterialInput,
    supersession?: CaptureSupersession,
    projectIds?: readonly string[],
  ): {
    material: Material;
    duplicate: boolean;
  } {
    const request = captureMaterialSchema.parse(
      redactFields(captureMaterialSchema.parse(input)),
    );
    const metadata = materialMetadata(
      request.metadata,
      request.metadata?.type ?? "note",
    );
    const fingerprint = this.#materialFingerprint(
      "material",
      request,
      metadata,
    );
    const saved = this.#capture(
      request,
      fingerprint,
      { metadata },
      undefined,
      supersession,
      projectIds,
    );
    const material = this.findMaterial(saved.source.id, request.scope);
    if (!material) throw new Error("Missing saved material");
    return { material, duplicate: saved.duplicate };
  }

  captureDocument(
    input: CaptureMaterialInput,
    document: DocumentInput,
    setBy: string,
    projectId: string,
  ): { material: Material; duplicate: boolean } {
    const request = captureMaterialSchema.parse(
      redactFields(captureMaterialSchema.parse(input)),
    );
    const parsed = parseDocument(document);
    const title = redact(parsed.title).trim();
    const key = redact(parsed.key);
    const status = redact(parsed.status);
    const actor = setBy.trim();
    if (
      !title ||
      title.length > 256 ||
      key !== parsed.key ||
      status !== parsed.status ||
      actor.length < 1 ||
      actor.length > 128 ||
      actor.includes("\0")
    )
      throw new Error("Invalid document identity");
    const written: DocumentWrite = {
      projectId,
      type: parsed.type,
      key,
      title,
      status,
      setBy: actor,
    };
    const metadata = materialMetadata(
      {
        ...request.metadata,
        type: written.type === "note" ? "note" : "document",
        title,
      },
      written.type === "note" ? "note" : "document",
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          this.#materialFingerprint("material", request, metadata),
          written.projectId,
          written.type,
          written.key,
          written.status,
          written.title,
        ]),
      )
      .digest("hex");
    const saved = this.#capture(
      request,
      fingerprint,
      { metadata },
      undefined,
      undefined,
      [projectId],
      written,
    );
    const material = this.findMaterial(saved.source.id, request.scope);
    if (!material?.doc) throw new Error("Missing saved document");
    return { material, duplicate: saved.duplicate };
  }

  // Only the validated, redacted import boundary calls this owner-local writer.
  importMaterial(
    input: CaptureMaterialInput,
    provenance: ImportProvenance,
    projectIds?: readonly string[],
    document?: DocumentWrite,
  ): { source: Source; duplicate: boolean; changed: boolean } {
    const request = captureMaterialSchema.parse(
      redactFields(captureMaterialSchema.parse(input)),
    );
    const imported: ImportProvenance = {
      ...provenance,
      metadata: canonicalRepositoryMetadata(provenance.metadata),
    };
    const metadata = materialMetadata(
      request.metadata,
      request.metadata?.type ?? "note",
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          this.#materialFingerprint("material", request, metadata),
          imported.source,
          imported.externalId,
          imported.kind ?? null,
          Object.entries(imported.metadata).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        ]),
      )
      .digest("hex");
    const saved = this.#capture(
      request,
      fingerprint,
      { metadata },
      imported,
      undefined,
      projectIds,
      document,
    );
    return { ...saved, changed: saved.changed ?? false };
  }

  captureFile(
    input: CaptureFileInput,
    supersession?: CaptureSupersession,
    projectIds?: readonly string[],
  ): {
    material: Material;
    duplicate: boolean;
  } {
    const original = captureFileSchema.parse(input);
    const request = captureFileSchema.parse({
      ...redactFields(original),
      contentBase64: Buffer.from(
        redact(decodeMaterialFile(original.contentBase64).text),
      ).toString("base64"),
    });
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
    const saved = this.#capture(
      sourceRequest,
      fingerprint,
      { metadata, file },
      undefined,
      supersession,
      projectIds,
    );
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
    captureFingerprint: string,
    material?: StoredMaterial,
    imported?: ImportProvenance,
    supersession?: CaptureSupersession,
    projectIds?: readonly string[],
    document?: DocumentWrite,
  ): { source: Source; duplicate: boolean; changed?: boolean } {
    // Omit projects from the hash unless the client sent them, so older retries match.
    const sortedProjects = projectIds
      ? [...rememberProjectsSchema.parse(projectIds)].sort()
      : undefined;
    const projectFingerprint = sortedProjects
      ? createHash("sha256")
          .update(JSON.stringify([captureFingerprint, sortedProjects]))
          .digest("hex")
      : captureFingerprint;
    const replacing = supersession
      ? {
          ids: supersedesSchema.parse(supersession.ids).sort(),
          creator: knowledgeCreatorSchema.parse({
            kind: "user",
            name: supersession.clientId,
          }),
        }
      : undefined;
    // Preserve old fingerprints when no supersession was requested.
    const fingerprint = replacing
      ? createHash("sha256")
          .update(JSON.stringify([projectFingerprint, replacing]))
          .digest("hex")
      : projectFingerprint;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const knowledge = replacing
        ? new KnowledgeStore(this.#database)
        : undefined;
      for (const id of replacing?.ids ?? []) {
        if (!knowledge?.hasEndpoint(id, request.scope))
          throw new KnowledgeNotFound("Replacement target unavailable");
      }
      const existing = imported
        ? this.#database
            .prepare(
              "SELECT fingerprint, source_id FROM source_imports WHERE source = ? AND external_id = ? AND fingerprint = ?",
            )
            .get(imported.source, imported.externalId, fingerprint)
        : this.#database
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
        const source = this.find(String(existing.source_id), request.scope, {
          includeRetired: true,
        });
        if (!source)
          throw new IdempotencyConflict("Source no longer in requested area");
        this.#database.exec("COMMIT");
        return { source, duplicate: true };
      }
      const changed = imported
        ? !!this.#database
            .prepare(
              "SELECT 1 FROM source_imports WHERE source = ? AND external_id = ? LIMIT 1",
            )
            .get(imported.source, imported.externalId)
        : false;
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
      if (document) {
        const current = this.#database
          .prepare(
            `SELECT COALESCE(MAX(revision), 0) AS revision FROM source_docs
             WHERE project_id = ? AND doc_type = ? AND doc_key = ?`,
          )
          .get(document.projectId, document.type, document.key) as
          | { revision?: number }
          | undefined;
        this.#database
          .prepare(
            `INSERT INTO source_docs
              (source_id, project_id, doc_type, doc_key, title, status, revision, set_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            source.id,
            document.projectId,
            document.type,
            document.key,
            document.title,
            document.status,
            Number(current?.revision ?? 0) + 1,
            document.setBy,
          );
      }
      if (imported) {
        this.#database
          .prepare(
            "INSERT INTO source_imports (source, external_id, source_id, fingerprint, provenance) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            imported.source,
            imported.externalId,
            source.id,
            fingerprint,
            JSON.stringify(imported),
          );
      } else
        this.#database
          .prepare(`
        INSERT INTO capture_requests (scope, request_key, fingerprint, source_id) VALUES (?, ?, ?, ?)
      `)
          .run(request.scope, request.idempotencyKey, fingerprint, source.id);
      if (imported)
        linkConfiguredImport(this.#database, source.id, imported.metadata);
      if (sortedProjects)
        linkClientProjects(this.#database, source.id, sortedProjects);
      if (replacing && knowledge)
        for (const id of replacing.ids) {
          knowledge.relate({
            version: 1,
            scope: request.scope,
            idempotencyKey: `remember:${createHash("sha256")
              .update(JSON.stringify([request.idempotencyKey, id]))
              .digest("hex")}`,
            kind: "supersedes",
            fromId: source.id,
            toId: id,
            sourceRefs: [{ sourceId: source.id }],
            creator: replacing.creator,
          });
        }
      this.#database.exec("COMMIT");
      return { source, duplicate: false, ...(imported ? { changed } : {}) };
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
      WHERE sources_fts MATCH ? AND s.scope = ? AND ${this.#visible("s.id")}
      ORDER BY sources_fts.rank, s.id LIMIT ?
    `)
      .all(phrase, scope, 101);
    const state = retrievalRelations(this.#database, scope);
    const found = new Map<string, Source>();
    for (const row of rows) {
      const id = String(row.id);
      const source =
        this.find(state.canonical(id), scope) ?? this.find(id, scope);
      const supersededBy = source && state.superseded.get(source.id);
      if (source)
        found.set(source.id, {
          ...source,
          ...(supersededBy ? { supersededBy } : {}),
        });
    }
    return [...found.values()]
      .sort((a, b) => Number(!!a.supersededBy) - Number(!!b.supersededBy))
      .slice(0, limit);
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

  find(
    id: string,
    scope: string,
    options?: { includeRetired?: boolean },
  ): Source | undefined {
    const hidden =
      options?.includeRetired || !this.#retirementReady
        ? ""
        : ` AND ${notRetired("id")}`;
    const row = this.#database
      .prepare(`
        SELECT id, text, origin, scope, captured_at AS capturedAt, checksum, status
        FROM sources WHERE id = ? AND scope = ?${hidden}
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
    const imported = this.#database
      .prepare("SELECT provenance FROM source_imports WHERE source_id = ?")
      .get(id);
    const doc = this.#document(id);
    return {
      source,
      metadata,
      ...(file ? { file } : {}),
      ...(imported
        ? {
            import: JSON.parse(String(imported.provenance)) as ImportProvenance,
          }
        : {}),
      ...(doc ? { doc } : {}),
    };
  }

  #document(id: string): SourceDocument | undefined {
    const row = this.#database
      .prepare(
        `SELECT project_id AS projectId, doc_type AS type, doc_key AS key,
                title, status, revision, set_by AS setBy
         FROM source_docs WHERE source_id = ?`,
      )
      .get(id) as SourceDocument | undefined;
    if (
      !row ||
      (row.type !== "adr" && row.type !== "spec" && row.type !== "note")
    )
      return undefined;
    return row;
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
    const conditions = ["s.scope = ?", "s.rowid <= ?", this.#visible("s.id")];
    const params: (string | number)[] = [input.scope, snapshot];
    if (input.from !== undefined) {
      conditions.push(`${date} >= ?`);
      params.push(Date.parse(input.from));
    }
    if (input.until !== undefined) {
      conditions.push(`${date} < ?`);
      params.push(Date.parse(input.until));
    }
    if (input.projectId) {
      conditions.push(linkedProjectSql("source", "s.id"));
      params.push(input.projectId);
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
    const conditions = ["s.scope = ?", this.#visible("s.id")];
    const params: (string | number)[] = [input.scope];
    if (input.from) {
      conditions.push(`${date} >= ?`);
      params.push(Date.parse(input.from));
    }
    if (input.until) {
      conditions.push(`${date} < ?`);
      params.push(Date.parse(input.until));
    }
    if (input.projectId) {
      conditions.push(linkedProjectSql("source", "s.id"));
      params.push(input.projectId);
    }
    conditions.push(
      `NOT (${staleDocumentSourceSql((column) => this.#visible(column))})`,
    );
    if (input.documentsOnly || input.docType) {
      conditions.push(
        currentDocumentSourceSql(input.docType !== undefined, (column) =>
          this.#visible(column),
        ),
      );
      if (input.docType) params.push(input.docType);
    }
    if (input.terms.length) {
      const found = lexicalCandidates(
        this.#database,
        "sources",
        `SELECT s.rowid,s.id,s.text FROM sources s LEFT JOIN source_metadata m ON m.source_id=s.id WHERE ${conditions.join(" AND ")}`,
        params,
        input.terms,
        input.limit,
        input.vectors,
        input.expansion,
      );
      const materials = found.ids.map((id) => {
        const material = this.findMaterial(id, input.scope);
        if (!material) throw new Error("Missing source candidate");
        return material;
      });
      const scores = new Map(found.scores);
      for (const material of materials) {
        if (!material.doc) continue;
        const score = scores.get(material.source.id);
        if (score === undefined || score <= 0) continue;
        scores.set(
          material.source.id,
          adjustDocumentScore(score, material.doc),
        );
      }
      materials.sort((a, b) => {
        const delta =
          (scores.get(b.source.id) ?? 0) - (scores.get(a.source.id) ?? 0);
        if (delta !== 0) return delta;
        return a.source.id.localeCompare(b.source.id);
      });
      return { ...found, scores, materials };
    }
    const from =
      "FROM sources s LEFT JOIN source_metadata m ON m.source_id = s.id";
    const where = conditions.join(" AND ");
    const total = Number(
      this.#database
        .prepare(`SELECT COUNT(*) n ${from} WHERE ${where}`)
        .get(...params)?.n,
    );
    const rows = this.#database
      .prepare(
        `SELECT s.id ${from} WHERE ${where} ORDER BY ${date} DESC,s.id LIMIT ?`,
      )
      .all(...params, input.limit);
    return {
      total,
      matchOffsets: new Map<string, number>(),
      scores: new Map<string, number>(),
      termHits: new Map<string, TermHit>(),
      queryTermMatches: 0,
      materials: rows.map((row) => {
        const material = this.findMaterial(String(row.id), input.scope);
        if (!material) throw new Error("Missing source candidate");
        return material;
      }),
    };
  }

  // Corpus size for grounding. The count is the pool search can match:
  // current sources in this area, or in this project, plus the knowledge rows
  // that same search returns. A project includes journals, decisions and
  // facts. An area leaves those three kinds out. A document filter counts
  // only the current documents and no knowledge. Other areas do not count.
  // Older revisions of a document do not count. A date window does not
  // shrink this corpus.
  documentFrequency(
    scope: string,
    terms: readonly string[],
    projectId?: string,
    documents?: { readonly type?: "adr" | "spec" | "note" },
  ): { documents: number; counts: Map<string, number> } {
    const source = this.#frequencyPool(
      "sources",
      scope,
      terms,
      projectId,
      documents,
    );
    const knowledge = documents
      ? undefined
      : this.#frequencyPool("knowledge", scope, terms, projectId);
    const counts = new Map<string, number>();
    for (const term of terms) {
      counts.set(
        term,
        (source.counts.get(term) ?? 0) + (knowledge?.counts.get(term) ?? 0),
      );
    }
    return {
      documents: source.documents + (knowledge?.documents ?? 0),
      counts,
    };
  }

  #frequencyPool(
    pool: "sources" | "knowledge",
    scope: string,
    terms: readonly string[],
    projectId?: string,
    documents?: { readonly type?: "adr" | "spec" | "note" },
  ): { documents: number; counts: Map<string, number> } {
    const counts = new Map<string, number>();
    if (pool === "knowledge" && !this.#hasKnowledgeIndex())
      return { documents: 0, counts };
    const conditions = [pool === "sources" ? "s.scope = ?" : "k.scope = ?"];
    const params: (string | number)[] = [scope];
    if (projectId) {
      conditions.push(
        linkedProjectSql(
          pool === "sources" ? "source" : "knowledge",
          pool === "sources" ? "s.id" : "k.id",
        ),
      );
      params.push(projectId);
    }
    if (pool === "sources") {
      conditions.push(this.#visible("s.id"));
      if (documents) {
        conditions.push(
          currentDocumentSourceSql(documents.type !== undefined, (column) =>
            this.#visible(column),
          ),
        );
        if (documents.type) params.push(documents.type);
      } else
        conditions.push(
          `NOT (${staleDocumentSourceSql((column) => this.#visible(column))})`,
        );
    } else {
      conditions.push(`${knowledgeMatchStatusSql} <> 'rejected'`);
      if (!projectId)
        conditions.push("k.kind NOT IN ('fact', 'decision', 'journal')");
    }
    const where = conditions.join(" AND ");
    const table = pool === "sources" ? "sources s" : "knowledge_items k";
    const stemmed =
      pool === "sources" ? "sources_stemmed" : "knowledge_items_stemmed";
    const rowid = pool === "sources" ? "s.rowid" : "k.rowid";
    const corpus = Number(
      this.#database
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)
        .get(...params)?.n,
    );
    const countStem = this.#database.prepare(
      `SELECT COUNT(*) n FROM ${stemmed} JOIN ${table} ON ${rowid} = ${stemmed}.rowid WHERE ${where} AND ${stemmed} MATCH ?`,
    );
    for (const term of terms) {
      const stem = stemText(term);
      counts.set(
        term,
        stem ? Number(countStem.get(...params, ftsTerms([stem]))?.n) : 0,
      );
    }
    return { documents: corpus, counts };
  }

  #hasKnowledgeIndex(): boolean {
    return Boolean(
      this.#database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'knowledge_items_stemmed'",
        )
        .get(),
    );
  }

  /** Id, name, and glossary terms for this project. Synonyms are not included. */
  projectIdentityTerms(projectId: string): string[] {
    const project = this.findProject(projectId);
    return projectIdentityWords(
      projectId,
      project?.name ?? "",
      this.projectGlossary(projectId).map((entry) => entry.term),
    );
  }

  createProject(input: {
    id: string;
    name: string;
    homeArea: string;
  }): Project {
    return createProject(this.#database, input);
  }

  renameProject(id: string, name: string): Project {
    return renameProject(this.#database, id, name);
  }

  listProjects(limit?: number): { projects: Project[]; truncated: boolean } {
    return listProjects(this.#database, limit);
  }

  findProject(id: string): Project | undefined {
    return findProject(this.#database, id);
  }

  listVisibleProjects(
    areas: readonly string[],
    limit?: number,
  ): { projects: Project[]; truncated: boolean } {
    return listVisibleProjects(this.#database, areas, limit);
  }

  mapRepository(repo: string, projectId: string): RepositoryMapping {
    return mapRepository(this.#database, repo, projectId);
  }

  unmapRepository(repo: string): void {
    unmapRepository(this.#database, repo);
  }

  repositoryMappings(): RepositoryMapping[] {
    return repositoryMappings(this.#database);
  }

  backfillProjects(): ProjectBackfill {
    return backfillProjects(this.#database);
  }

  associationsFor(
    kind: ProjectRecordKind,
    recordId: string,
  ): ProjectAssociation[] {
    return associationsFor(this.#database, kind, recordId);
  }

  hasProject(id: string): boolean {
    return hasProject(this.#database, id);
  }

  linkedToProject(
    kind: ProjectRecordKind,
    recordId: string,
    projectId: string,
  ): boolean {
    return isLinkedToProject(this.#database, kind, recordId, projectId);
  }

  addClientAssociation(
    kind: ProjectRecordKind,
    recordId: string,
    projectIds: readonly string[],
  ): void {
    addClientAssociation(this.#database, kind, recordId, projectIds);
  }

  proposeProjectLink(input: {
    recordKind: ProjectRecordKind;
    recordId: string;
    sourceId: string;
    projectId?: string;
    suggestedName?: string;
  }): void {
    proposeProjectLink(this.#database, input);
  }

  setProfile(input: {
    projectId: string;
    purpose: string;
    rules: string;
    pinned?: readonly string[];
  }): ProjectProfile {
    return setProjectProfile(this.#database, input);
  }

  profile(projectId: string): ProjectProfile | undefined {
    return getProjectProfile(this.#database, projectId);
  }

  clearProfile(projectId: string): void {
    clearProjectProfile(this.#database, projectId);
  }

  projectGlossary(projectId: string): ProjectGlossaryEntry[] {
    return listProjectGlossary(this.#database, projectId);
  }

  glossary(projectId?: string): GlossaryEntry[] {
    const stored = projectId ? this.projectGlossary(projectId) : [];
    return mergeGlossary(builtinGlossary, stored);
  }

  setGlossaryTerm(input: {
    projectId: string;
    term: string;
    synonyms: readonly string[];
  }): ProjectGlossaryEntry {
    return setProjectGlossaryTerm(this.#database, input);
  }

  unsetGlossaryTerm(projectId: string, term: string): void {
    unsetProjectGlossaryTerm(this.#database, projectId, term);
  }

  expandedTerms(terms: readonly string[], projectId?: string): ExpandedTerm[] {
    return expandQueryTerms(terms, this.glossary(projectId));
  }

  readProfile(id: string, scope: string): ProjectProfile | undefined {
    return readProjectProfile(this.#database, id, scope);
  }

  currentDocument(
    projectId: string,
    type: SourceDocument["type"],
    key: string,
  ): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT d.source_id FROM source_docs d
         WHERE d.project_id = ? AND d.doc_type = ? AND d.doc_key = ?
           AND ${this.#visible("d.source_id")}
           AND d.revision = (
             SELECT MAX(d2.revision) FROM source_docs d2
             WHERE d2.project_id = d.project_id
               AND d2.doc_type = d.doc_type
               AND d2.doc_key = d.doc_key
               AND ${this.#visible("d2.source_id")}
           )`,
      )
      .get(projectId, type, key) as { source_id?: string } | undefined;
    return typeof row?.source_id === "string" ? row.source_id : undefined;
  }

  documentRevisions(
    projectId: string,
    type: SourceDocument["type"],
    key: string,
    scope: string,
  ): DocumentRevisionSummary[] {
    const rows = this.#database
      .prepare(
        `SELECT d.revision, d.source_id AS id, d.status, d.title,
                d.set_by AS setBy, s.captured_at AS capturedAt
         FROM source_docs d JOIN sources s ON s.id = d.source_id
         WHERE d.project_id = ? AND d.doc_type = ? AND d.doc_key = ?
           AND s.scope = ?
           AND ${this.#visible("d.source_id")}
         ORDER BY d.revision DESC`,
      )
      .all(projectId, type, key, scope) as unknown as DocumentRevisionSummary[];
    return rows;
  }

  resolveDocument(
    id: string,
    scope: string,
  ): { material: Material; revisions: DocumentRevisionSummary[] } | undefined {
    const hits: { material: Material; revisions: DocumentRevisionSummary[] }[] =
      [];
    const seen = new Set<string>();
    for (const ref of documentRefCandidates(id)) {
      const found = this.#findDocument(ref, scope);
      if (!found || seen.has(found.material.source.id)) continue;
      seen.add(found.material.source.id);
      hits.push(found);
    }
    return hits.length === 1 ? hits[0] : undefined;
  }

  #findDocument(
    ref: DocumentRef,
    scope: string,
  ): { material: Material; revisions: DocumentRevisionSummary[] } | undefined {
    const row = (
      ref.revision === undefined
        ? this.#database
            .prepare(
              `SELECT d.source_id FROM source_docs d
               WHERE d.project_id = ? AND d.doc_type = ? AND d.doc_key = ?
                 AND ${this.#visible("d.source_id")}
                 AND d.revision = (
                   SELECT MAX(d2.revision) FROM source_docs d2
                   WHERE d2.project_id = d.project_id
                     AND d2.doc_type = d.doc_type
                     AND d2.doc_key = d.doc_key
                     AND ${this.#visible("d2.source_id")}
                 )`,
            )
            .get(ref.projectId, ref.type, ref.key)
        : this.#database
            .prepare(
              `SELECT source_id FROM source_docs
               WHERE project_id = ? AND doc_type = ? AND doc_key = ?
                 AND revision = ?
                 AND ${this.#visible("source_id")}`,
            )
            .get(ref.projectId, ref.type, ref.key, ref.revision)
    ) as { source_id?: string } | undefined;
    if (typeof row?.source_id !== "string") return undefined;
    const material = this.findMaterial(row.source_id, scope);
    if (!material?.doc) return undefined;
    return {
      material,
      revisions: this.documentRevisions(
        material.doc.projectId,
        material.doc.type,
        material.doc.key,
        scope,
      ),
    };
  }

  checkHealth(): void {
    this.#database.prepare("SELECT 1 FROM sources LIMIT 1").get();
  }

  noteMarkdownRoot(sourceId: string, root: string): void {
    if (!root || root.length > 4096) return;
    this.#database
      .prepare(
        `INSERT INTO markdown_import_roots (source_id, root) VALUES (?, ?)
         ON CONFLICT(source_id) DO NOTHING`,
      )
      .run(sourceId, root);
  }

  restoreSource(sourceId: string): void {
    if (!this.#retirementReady) return;
    this.#database
      .prepare("DELETE FROM source_retirements WHERE source_id = ?")
      .run(sourceId);
  }

  retireSource(
    sourceId: string,
    reason: "import_prune" | "doc_remove",
  ): boolean {
    if (!this.#retirementReady) return false;
    const result = this.#database
      .prepare(
        `INSERT INTO source_retirements (source_id, retired_at, reason)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sources WHERE id = ?)
         ON CONFLICT(source_id) DO NOTHING`,
      )
      .run(sourceId, new Date().toISOString(), reason, sourceId);
    return Number(result.changes) > 0;
  }

  markdownPruneCandidates(
    area: string,
    project: string | undefined,
    root: string,
    includeRootless = false,
  ): { id: string; externalId: string }[] {
    const projectSql = project
      ? `EXISTS (SELECT 1 FROM project_associations pa
           WHERE pa.record_kind = 'source' AND pa.record_id = s.id
             AND pa.project_id = ? AND pa.status = 'linked')`
      : `NOT EXISTS (SELECT 1 FROM project_associations pa
           WHERE pa.record_kind = 'source' AND pa.record_id = s.id
             AND pa.status = 'linked')`;
    // A source imported before roots were recorded has no row. It does not
    // belong to every folder. Only --prune-legacy opts into those rows.
    const rootSql = includeRootless
      ? "(roots.root = ? OR roots.root IS NULL)"
      : "roots.root = ?";
    const params = project
      ? ["markdown", area, root, project]
      : ["markdown", area, root];
    return this.#database
      .prepare(
        `SELECT DISTINCT i.source_id AS id, i.external_id AS externalId
         FROM source_imports i
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN markdown_import_roots roots ON roots.source_id = s.id
         WHERE i.source = ?
           AND s.scope = ?
           AND ${rootSql}
           AND ${this.#visible("s.id")}
           AND ${projectSql}`,
      )
      .all(...params)
      .map((row) => ({
        id: String(row.id),
        externalId: String(row.externalId),
      }));
  }

  /** Owner removal. A document id retires every revision of that document. */
  removeRecord(id: string): { removed: number; id: string } | undefined {
    if (id.startsWith("doc:")) {
      const refs = documentRefCandidates(id);
      const ref = refs.length === 1 ? refs[0] : undefined;
      if (!ref) return undefined;
      const rows = this.#database
        .prepare(
          `SELECT source_id FROM source_docs
           WHERE project_id = ? AND doc_type = ? AND doc_key = ?`,
        )
        .all(ref.projectId, ref.type, ref.key);
      if (!rows.length) return undefined;
      let removed = 0;
      for (const row of rows) {
        if (this.retireSource(String(row.source_id), "doc_remove"))
          removed += 1;
      }
      return { removed, id: `doc:${ref.projectId}:${ref.type}:${ref.key}` };
    }
    const exists = this.#database
      .prepare("SELECT id FROM sources WHERE id = ?")
      .get(id);
    if (!exists) return undefined;
    const doc = this.#document(id);
    if (doc)
      return this.removeRecord(`doc:${doc.projectId}:${doc.type}:${doc.key}`);
    return { removed: this.retireSource(id, "doc_remove") ? 1 : 0, id };
  }

  /**
   * Undo a retirement. A document id restores every revision of that document.
   * A source id that belongs to a document does the same. Already-visible rows
   * report restored 0. Missing ids return undefined.
   */
  restoreRecord(id: string): { restored: number; id: string } | undefined {
    const target = this.#retirementTargets(id);
    if (!target) return undefined;
    let restored = 0;
    const clear = this.#database.prepare(
      "DELETE FROM source_retirements WHERE source_id = ?",
    );
    for (const sourceId of target.sources)
      restored += Number(clear.run(sourceId).changes);
    return { restored, id: target.id };
  }

  #retirementTargets(
    id: string,
  ): { id: string; sources: string[] } | undefined {
    if (id.startsWith("doc:")) {
      const refs = documentRefCandidates(id);
      const ref = refs.length === 1 ? refs[0] : undefined;
      if (!ref) return undefined;
      const rows = this.#database
        .prepare(
          `SELECT source_id FROM source_docs
           WHERE project_id = ? AND doc_type = ? AND doc_key = ?`,
        )
        .all(ref.projectId, ref.type, ref.key);
      if (!rows.length) return undefined;
      return {
        id: `doc:${ref.projectId}:${ref.type}:${ref.key}`,
        sources: rows.map((row) => String(row.source_id)),
      };
    }
    const exists = this.#database
      .prepare("SELECT id FROM sources WHERE id = ?")
      .get(id);
    if (!exists) return undefined;
    const doc = this.#document(id);
    if (doc)
      return this.#retirementTargets(
        `doc:${doc.projectId}:${doc.type}:${doc.key}`,
      );
    return { id, sources: [id] };
  }

  /** Owner-local counts for `context status`. Knowledge is absent until that table exists. */
  instanceCounts(): {
    sourcesActive: number;
    sourcesRetired: number;
    docs: number;
    knowledgeItems: number;
    projects: number;
  } {
    const count = (sql: string) =>
      Number(this.#database.prepare(sql).get()?.n ?? 0);
    const has = (name: string) =>
      !!this.#database
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name);
    const sourcesRetired = has("source_retirements")
      ? count("SELECT COUNT(*) AS n FROM source_retirements")
      : 0;
    const sourcesActive = has("source_retirements")
      ? count(
          `SELECT COUNT(*) AS n FROM sources s
           WHERE NOT EXISTS (
             SELECT 1 FROM source_retirements r WHERE r.source_id = s.id
           )`,
        )
      : count("SELECT COUNT(*) AS n FROM sources");
    return {
      sourcesActive,
      sourcesRetired,
      docs: has("source_docs")
        ? count(
            `SELECT COUNT(*) AS n FROM (
               SELECT DISTINCT project_id, doc_type, doc_key FROM source_docs
             )`,
          )
        : 0,
      knowledgeItems: has("knowledge_items")
        ? count("SELECT COUNT(*) AS n FROM knowledge_items")
        : 0,
      projects: has("projects")
        ? count("SELECT COUNT(*) AS n FROM projects")
        : 0,
    };
  }

  #hasRetirementTable(): boolean {
    return !!this.#database
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'source_retirements'",
      )
      .get();
  }

  #installRetirement(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS source_retirements (
        source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
        retired_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('import_prune', 'doc_remove'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS markdown_import_roots (
        source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
        root TEXT NOT NULL CHECK(length(root) BETWEEN 1 AND 4096)
      ) STRICT;
    `);
    this.#retirementReady = true;
  }

  #visible(column: string): string {
    return this.#retirementReady ? notRetired(column) : "1";
  }

  close(): void {
    this.#database.close();
  }
}
