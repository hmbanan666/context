import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { identifierSchema, nonblankText, scopeSchema } from "./contracts.js";

// ADR 0010. A project is not an area and not a permission. Processor proposals
// are stored here; approval is a later slice, so a suggestion has no project id.
export const maxListedProjects = 64;
export const projectIdSchema = scopeSchema.pipe(z.string().max(64));
export const projectNameSchema = nonblankText(128);
export const repositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/);
export const rememberProjectsSchema = z
  .array(projectIdSchema)
  .min(1)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Duplicate project id",
  });
const recordKindSchema = z.enum(["source", "knowledge"]);
export type ProjectRecordKind = z.infer<typeof recordKindSchema>;
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly homeArea: string;
}
export interface RepositoryMapping {
  readonly repo: string;
  readonly projectId: string;
}
export interface ProjectAssociation {
  readonly origin: "configured" | "client" | "proposed";
  readonly status: "linked" | "proposed";
  readonly projectId?: string;
  readonly suggestedName?: string;
}
export interface ProjectBackfill {
  readonly sources: number;
  readonly derived: number;
  readonly changed: number;
}
export class UnknownProject extends Error {
  constructor(readonly ids: readonly string[]) {
    super(`Unknown project: ${ids.join(", ")}`);
    this.name = "UnknownProject";
  }
}
export class ProjectExists extends Error {
  constructor() {
    super("Project already exists");
    this.name = "ProjectExists";
  }
}

const columns = { "s.id": "s.id", "k.id": "k.id" } as const;
export function linkedProjectSql(
  kind: ProjectRecordKind,
  column: keyof typeof columns,
): string {
  return `EXISTS (SELECT 1 FROM project_associations pa WHERE pa.record_kind = '${kind}' AND pa.record_id = ${columns[column]} AND pa.project_id = ? AND pa.status = 'linked')`;
}

export function installProjects(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
      home_area TEXT NOT NULL CHECK(length(home_area) BETWEEN 1 AND 80),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS project_repo_mappings (
      repo TEXT PRIMARY KEY NOT NULL CHECK(length(repo) BETWEEN 3 AND 201),
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS project_associations (
      record_kind TEXT NOT NULL CHECK(record_kind IN ('source', 'knowledge')),
      record_id TEXT NOT NULL CHECK(length(record_id) > 0),
      project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 64),
      origin TEXT NOT NULL CHECK(origin IN ('configured', 'client', 'proposed')),
      status TEXT NOT NULL CHECK(status IN ('linked', 'proposed')),
      PRIMARY KEY (record_kind, record_id, project_id, origin)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS project_associations_project
      ON project_associations(project_id, status, record_kind, record_id);
    CREATE INDEX IF NOT EXISTS project_associations_record
      ON project_associations(record_kind, record_id);
    CREATE TABLE IF NOT EXISTS project_proposals (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
      record_kind TEXT NOT NULL CHECK(record_kind IN ('source', 'knowledge')),
      record_id TEXT NOT NULL CHECK(length(record_id) > 0),
      source_id TEXT NOT NULL CHECK(length(source_id) > 0),
      suggested_name TEXT NOT NULL CHECK(length(suggested_name) BETWEEN 1 AND 128),
      created_at TEXT NOT NULL,
      UNIQUE (record_kind, record_id, suggested_name)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS project_proposals_record
      ON project_proposals(record_kind, record_id);
  `);
}

function write<T>(db: DatabaseSync, run: () => T): T {
  if (db.isTransaction) return run();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function projectRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").get(id);
}
export function hasProject(db: DatabaseSync, id: string): boolean {
  return !!projectRow(db, projectIdSchema.parse(id));
}
function missingProjects(db: DatabaseSync, ids: readonly string[]): string[] {
  return ids.filter((id) => !projectRow(db, id));
}
function assertRecord(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  id: string,
): void {
  identifierSchema.parse(id);
  const found =
    kind === "source"
      ? db.prepare("SELECT 1 AS ok FROM sources WHERE id = ?").get(id)
      : db
          .prepare(
            "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_items'",
          )
          .get() &&
        db.prepare("SELECT 1 AS ok FROM knowledge_items WHERE id = ?").get(id);
  if (!found) throw new Error("Record not found");
}
function decodeProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    homeArea: String(row.home_area),
  };
}

export function createProject(
  db: DatabaseSync,
  input: { id: string; name: string; homeArea: string },
): Project {
  const id = projectIdSchema.parse(input.id);
  const name = projectNameSchema.parse(input.name);
  const homeArea = scopeSchema.parse(input.homeArea);
  return write(db, () => {
    if (projectRow(db, id)) throw new ProjectExists();
    try {
      db.prepare(
        "INSERT INTO projects (id, name, home_area, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, name, homeArea, new Date().toISOString());
    } catch (error) {
      if (projectRow(db, id)) throw new ProjectExists();
      throw error;
    }
    return { id, name, homeArea };
  });
}
export function renameProject(
  db: DatabaseSync,
  id: string,
  name: string,
): Project {
  const projectId = projectIdSchema.parse(id);
  const next = projectNameSchema.parse(name);
  return write(db, () => {
    const result = db
      .prepare("UPDATE projects SET name = ? WHERE id = ?")
      .run(next, projectId);
    if (Number(result.changes) !== 1) throw new UnknownProject([projectId]);
    const row = db
      .prepare("SELECT id, name, home_area FROM projects WHERE id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw new UnknownProject([projectId]);
    return decodeProject(row);
  });
}
export function listProjects(
  db: DatabaseSync,
  limit?: number,
): { projects: Project[]; truncated: boolean } {
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
  )
    throw new Error("Invalid project catalog limit");
  const rows = (
    limit === undefined
      ? db.prepare("SELECT id, name, home_area FROM projects ORDER BY id").all()
      : db
          .prepare(
            "SELECT id, name, home_area FROM projects ORDER BY id LIMIT ?",
          )
          .all(limit + 1)
  ) as Record<string, unknown>[];
  const truncated = limit !== undefined && rows.length > limit;
  return {
    projects: (truncated ? rows.slice(0, limit) : rows).map(decodeProject),
    truncated,
  };
}
function mappedProject(db: DatabaseSync, repo: string): string | undefined {
  const row = db
    .prepare(
      `SELECT m.project_id AS projectId FROM project_repo_mappings m
       JOIN projects p ON p.id = m.project_id WHERE m.repo = ?`,
    )
    .get(repo) as { projectId?: unknown } | undefined;
  return row ? String(row.projectId) : undefined;
}
export function mapRepository(
  db: DatabaseSync,
  repo: string,
  projectId: string,
): RepositoryMapping {
  const fullName = repositoryNameSchema.parse(repo);
  const id = projectIdSchema.parse(projectId);
  return write(db, () => {
    if (!projectRow(db, id)) throw new UnknownProject([id]);
    db.prepare(
      `INSERT INTO project_repo_mappings (repo, project_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET project_id = excluded.project_id`,
    ).run(fullName, id, new Date().toISOString());
    return { repo: fullName, projectId: id };
  });
}
export function unmapRepository(db: DatabaseSync, repo: string): void {
  const fullName = repositoryNameSchema.parse(repo);
  write(db, () => {
    db.prepare("DELETE FROM project_repo_mappings WHERE repo = ?").run(
      fullName,
    );
  });
}
export function repositoryMappings(db: DatabaseSync): RepositoryMapping[] {
  return (
    db
      .prepare(
        "SELECT repo, project_id AS projectId FROM project_repo_mappings ORDER BY repo",
      )
      .all() as { repo: string; projectId: string }[]
  ).map((row) => ({ repo: row.repo, projectId: row.projectId }));
}

function insertLinks(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  recordId: string,
  projectIds: readonly string[],
  origin: "client" | "configured",
): void {
  const ids = [...rememberProjectsSchema.parse(projectIds)].sort();
  const missing = missingProjects(db, ids);
  if (missing.length) throw new UnknownProject(missing);
  const insert = db.prepare(
    `INSERT INTO project_associations
      (record_kind, record_id, project_id, origin, status)
     VALUES (?, ?, ?, ?, 'linked')`,
  );
  for (const id of ids) insert.run(kind, recordId, id, origin);
}
export function linkClientProjects(
  db: DatabaseSync,
  sourceId: string,
  projectIds: readonly string[],
): void {
  insertLinks(db, "source", sourceId, projectIds, "client");
}
export function addClientAssociation(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  recordId: string,
  projectIds: readonly string[],
): void {
  write(db, () => {
    assertRecord(db, kind, recordId);
    insertLinks(db, kind, recordId, projectIds, "client");
  });
}
export function linkConfiguredImport(
  db: DatabaseSync,
  sourceId: string,
  metadata: Record<string, string>,
): void {
  const projectId = metadata.repo
    ? mappedProject(db, metadata.repo)
    : undefined;
  if (!projectId) return;
  insertLinks(db, "source", sourceId, [projectId], "configured");
}

function configuredIds(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  recordId: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT project_id AS projectId FROM project_associations
         WHERE record_kind = ? AND record_id = ? AND origin = 'configured'
         ORDER BY project_id`,
      )
      .all(kind, recordId) as { projectId: string }[]
  ).map((row) => row.projectId);
}
function replaceConfigured(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  recordId: string,
  projectIds: readonly string[],
): boolean {
  const desired = [...new Set(projectIds)].sort();
  const current = configuredIds(db, kind, recordId);
  if (
    current.length === desired.length &&
    current.every((id, index) => id === desired[index])
  )
    return false;
  db.prepare(
    `DELETE FROM project_associations
     WHERE record_kind = ? AND record_id = ? AND origin = 'configured'`,
  ).run(kind, recordId);
  if (desired.length) insertLinks(db, kind, recordId, desired, "configured");
  return true;
}
export function backfillProjects(db: DatabaseSync): ProjectBackfill {
  return write(db, () => {
    const repos = new Map<string, string | undefined>();
    for (const row of db
      .prepare("SELECT source_id, provenance FROM source_imports")
      .all() as { source_id: unknown; provenance: unknown }[]) {
      let metadata: Record<string, string> | undefined;
      try {
        const parsed = JSON.parse(String(row.provenance)) as {
          metadata?: Record<string, string>;
        };
        metadata = parsed.metadata;
      } catch {
        continue;
      }
      const id = String(row.source_id);
      const repo = metadata?.repo || undefined;
      repos.set(id, repos.get(id) || repo);
    }
    let changed = 0;
    for (const [sourceId, repo] of repos) {
      const projectId = repo ? mappedProject(db, repo) : undefined;
      if (
        replaceConfigured(db, "source", sourceId, projectId ? [projectId] : [])
      )
        changed++;
    }
    let derived = 0;
    if (
      db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_items'",
        )
        .get()
    ) {
      for (const row of db
        .prepare("SELECT id, source_refs FROM knowledge_items")
        .all() as { id: unknown; source_refs: unknown }[]) {
        let refs: { sourceId?: string }[];
        try {
          const parsed = JSON.parse(String(row.source_refs)) as unknown;
          if (!Array.isArray(parsed)) continue;
          refs = parsed as { sourceId?: string }[];
        } catch {
          continue;
        }
        derived++;
        const projects = new Set<string>();
        for (const ref of refs) {
          const repo = ref.sourceId ? repos.get(ref.sourceId) : undefined;
          const projectId = repo ? mappedProject(db, repo) : undefined;
          if (projectId) projects.add(projectId);
        }
        if (replaceConfigured(db, "knowledge", String(row.id), [...projects]))
          changed++;
      }
    }
    return { sources: repos.size, derived, changed };
  });
}

export function associationsFor(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  recordId: string,
): ProjectAssociation[] {
  const link = z.object({
    project_id: z.string(),
    origin: z.enum(["configured", "client", "proposed"]),
    status: z.enum(["linked", "proposed"]),
  });
  const links = (
    db
      .prepare(
        `SELECT project_id, origin, status FROM project_associations
         WHERE record_kind = ? AND record_id = ? ORDER BY project_id, origin`,
      )
      .all(kind, recordId) as Record<string, unknown>[]
  ).map((row) => {
    const parsed = link.parse(row);
    return {
      projectId: parsed.project_id,
      origin: parsed.origin,
      status: parsed.status,
    };
  });
  const names = db
    .prepare(
      `SELECT suggested_name FROM project_proposals
       WHERE record_kind = ? AND record_id = ? ORDER BY suggested_name, id`,
    )
    .all(kind, recordId) as { suggested_name: string }[];
  return [
    ...links,
    ...names.map((row) => ({
      origin: "proposed" as const,
      status: "proposed" as const,
      suggestedName: row.suggested_name,
    })),
  ];
}
export function isLinkedToProject(
  db: DatabaseSync,
  kind: ProjectRecordKind,
  recordId: string,
  projectId: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 AS ok FROM project_associations
       WHERE record_kind = ? AND record_id = ? AND project_id = ? AND status = 'linked'`,
    )
    .get(kind, recordId, projectId);
}
export function proposeProjectLink(
  db: DatabaseSync,
  input: {
    recordKind: ProjectRecordKind;
    recordId: string;
    sourceId: string;
    projectId?: string;
    suggestedName?: string;
  },
): void {
  const kind = recordKindSchema.parse(input.recordKind);
  const recordId = identifierSchema.parse(input.recordId);
  const sourceId = identifierSchema.parse(input.sourceId);
  if ((input.projectId === undefined) === (input.suggestedName === undefined))
    throw new Error("Propose a project id or a suggested name");
  write(db, () => {
    assertRecord(db, kind, recordId);
    assertRecord(db, "source", sourceId);
    if (input.projectId !== undefined) {
      const projectId = projectIdSchema.parse(input.projectId);
      if (!projectRow(db, projectId)) throw new UnknownProject([projectId]);
      const linked = db
        .prepare(
          `SELECT 1 AS ok FROM project_associations
           WHERE record_kind = ? AND record_id = ? AND project_id = ? AND status = 'linked'`,
        )
        .get(kind, recordId, projectId);
      if (linked) return;
      db.prepare(
        `INSERT OR IGNORE INTO project_associations
          (record_kind, record_id, project_id, origin, status)
         VALUES (?, ?, ?, 'proposed', 'proposed')`,
      ).run(kind, recordId, projectId);
      return;
    }
    const suggestedName = projectNameSchema.parse(input.suggestedName);
    // Not a project id. remember and search reject it until a later approval slice.
    db.prepare(
      `INSERT OR IGNORE INTO project_proposals
        (id, record_kind, record_id, source_id, suggested_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `proposal:${randomUUID()}`,
      kind,
      recordId,
      sourceId,
      suggestedName,
      new Date().toISOString(),
    );
  });
}
