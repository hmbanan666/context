import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { maxGlossaryWords, phraseWords } from "./glossary.js";
import { identifierSchema, nonblankText, scopeSchema } from "./contracts.js";
import { installJournalMeta } from "./journal.js";
import { latestReviewStatusSql } from "./review-status.js";

// ADR 0010. A project is not an area and not a permission. A suggested name
// has no project id until the owner approves it and assigns one.
export const maxListedProjects = 64;
export const projectIdSchema = scopeSchema.pipe(z.string().max(64));
export const projectNameSchema = nonblankText(128);
export const repositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/);
const repositoryPart = /^[A-Za-z0-9._-]{1,100}$/u;

// Match key for owner/repo. GitHub web, ssh, and git@ forms collapse to the
// lowercase full name. Anything else (a non-GitHub URL, an extra path) is left
// for the caller to keep unchanged. This does not rewrite stored source text.
export function normalizeRepositoryName(input: string): string | undefined {
  let value = input.trim().replace(/\/+$/u, "");
  if (!value) return undefined;
  const scp = /^git@github\.com:(.+)$/iu.exec(value);
  if (scp?.[1]) value = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.hostname.toLowerCase().replace(/^www\./u, "") !== "github.com")
      return undefined;
    value = url.pathname.replace(/^\/+/u, "");
  } else if (/^(?:www\.)?github\.com\//iu.test(value))
    value = value.replace(/^(?:www\.)?github\.com\//iu, "");
  value = value
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "");
  const parts = value.split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0];
  const repo = parts[1];
  if (
    !owner ||
    !repo ||
    !repositoryPart.test(owner) ||
    !repositoryPart.test(repo)
  )
    return undefined;
  const name = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return repositoryNameSchema.safeParse(name).success ? name : undefined;
}
export function canonicalRepositoryMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const repo = metadata.repo;
  if (repo === undefined) return metadata;
  const normalized = normalizeRepositoryName(repo);
  if (!normalized || normalized === repo) return metadata;
  return { ...metadata, repo: normalized };
}
function repositoryKey(repo: string): string {
  return normalizeRepositoryName(repo) ?? repo;
}
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

const columns = { "s.id": "s.id", "k.id": "k.id", "r.id": "r.id" } as const;
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
      status TEXT NOT NULL CHECK(status IN ('linked', 'proposed', 'rejected')),
      reviewer TEXT,
      reviewed_at TEXT,
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
      status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'approved', 'rejected')),
      project_id TEXT,
      reviewer TEXT,
      reviewed_at TEXT,
      UNIQUE (record_kind, record_id, suggested_name)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS project_proposals_record
      ON project_proposals(record_kind, record_id);
    CREATE TABLE IF NOT EXISTS project_profiles (
      project_id TEXT PRIMARY KEY NOT NULL,
      purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 2048),
      rules TEXT NOT NULL CHECK(length(rules) BETWEEN 1 AND 2048),
      pinned TEXT NOT NULL CHECK(length(pinned) BETWEEN 2 AND 2048),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS project_glossary (
      project_id TEXT NOT NULL,
      term TEXT NOT NULL CHECK(length(term) BETWEEN 1 AND 64),
      synonyms TEXT NOT NULL CHECK(length(synonyms) BETWEEN 2 AND 2048),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, term),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    ) STRICT;
  `);
  migrateProjectTables(db);
  installJournalMeta(db);
}

function tableColumns(
  db: DatabaseSync,
  table: "project_associations" | "project_proposals",
): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

function migrateProjectTables(db: DatabaseSync): void {
  const associations = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'project_associations'",
        )
        .get() as { sql?: string } | undefined
    )?.sql ?? "",
  );
  const proposalColumns = tableColumns(db, "project_proposals");
  if (associations.includes("'rejected'") && proposalColumns.includes("status"))
    return;
  write(db, () => {
    if (!associations.includes("'rejected'")) {
      db.exec(`
        DROP INDEX IF EXISTS project_associations_project;
        DROP INDEX IF EXISTS project_associations_record;
        ALTER TABLE project_associations RENAME TO project_associations_old;
        CREATE TABLE project_associations (
          record_kind TEXT NOT NULL CHECK(record_kind IN ('source', 'knowledge')),
          record_id TEXT NOT NULL CHECK(length(record_id) > 0),
          project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 64),
          origin TEXT NOT NULL CHECK(origin IN ('configured', 'client', 'proposed')),
          status TEXT NOT NULL CHECK(status IN ('linked', 'proposed', 'rejected')),
          reviewer TEXT,
          reviewed_at TEXT,
          PRIMARY KEY (record_kind, record_id, project_id, origin)
        ) STRICT;
        INSERT INTO project_associations (
          record_kind, record_id, project_id, origin, status, reviewer, reviewed_at
        )
        SELECT record_kind, record_id, project_id, origin, status, NULL, NULL
        FROM project_associations_old;
        DROP TABLE project_associations_old;
        CREATE INDEX project_associations_project
          ON project_associations(project_id, status, record_kind, record_id);
        CREATE INDEX project_associations_record
          ON project_associations(record_kind, record_id);
      `);
    }
    if (!proposalColumns.includes("status")) {
      db.exec(`
        DROP INDEX IF EXISTS project_proposals_record;
        ALTER TABLE project_proposals RENAME TO project_proposals_old;
        CREATE TABLE project_proposals (
          id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
          record_kind TEXT NOT NULL CHECK(record_kind IN ('source', 'knowledge')),
          record_id TEXT NOT NULL CHECK(length(record_id) > 0),
          source_id TEXT NOT NULL CHECK(length(source_id) > 0),
          suggested_name TEXT NOT NULL CHECK(length(suggested_name) BETWEEN 1 AND 128),
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'approved', 'rejected')),
          project_id TEXT,
          reviewer TEXT,
          reviewed_at TEXT,
          UNIQUE (record_kind, record_id, suggested_name)
        ) STRICT;
        INSERT INTO project_proposals (
          id, record_kind, record_id, source_id, suggested_name, created_at, status
        )
        SELECT id, record_kind, record_id, source_id, suggested_name, created_at, 'proposed'
        FROM project_proposals_old;
        DROP TABLE project_proposals_old;
        CREATE INDEX project_proposals_record
          ON project_proposals(record_kind, record_id);
      `);
    }
  });
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
  const key = repositoryKey(repo);
  const row = db
    .prepare(
      `SELECT m.project_id AS projectId FROM project_repo_mappings m
       JOIN projects p ON p.id = m.project_id
       WHERE lower(m.repo) = lower(?)
       ORDER BY CASE WHEN m.repo = ? THEN 0 ELSE 1 END, m.repo
       LIMIT 1`,
    )
    .get(key, key) as { projectId?: unknown } | undefined;
  return row ? String(row.projectId) : undefined;
}
function requireRepository(repo: string): string {
  const fullName = normalizeRepositoryName(repo);
  if (fullName) return fullName;
  repositoryNameSchema.parse(repo);
  throw new Error("Invalid repository");
}
export function mapRepository(
  db: DatabaseSync,
  repo: string,
  projectId: string,
): RepositoryMapping {
  const fullName = requireRepository(repo);
  const id = projectIdSchema.parse(projectId);
  return write(db, () => {
    if (!projectRow(db, id)) throw new UnknownProject([id]);
    const existing = db
      .prepare(
        `SELECT created_at FROM project_repo_mappings
         WHERE lower(repo) = ? ORDER BY created_at LIMIT 1`,
      )
      .get(fullName) as { created_at?: unknown } | undefined;
    const created =
      typeof existing?.created_at === "string"
        ? existing.created_at
        : new Date().toISOString();
    db.prepare("DELETE FROM project_repo_mappings WHERE lower(repo) = ?").run(
      fullName,
    );
    db.prepare(
      "INSERT INTO project_repo_mappings (repo, project_id, created_at) VALUES (?, ?, ?)",
    ).run(fullName, id, created);
    return { repo: fullName, projectId: id };
  });
}
export function unmapRepository(db: DatabaseSync, repo: string): void {
  const fullName = requireRepository(repo);
  write(db, () => {
    db.prepare("DELETE FROM project_repo_mappings WHERE lower(repo) = ?").run(
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
    ? mappedProject(db, repositoryKey(metadata.repo))
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
      const raw = metadata?.repo || undefined;
      const repo = raw ? repositoryKey(raw) : undefined;
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
        .prepare("SELECT id, kind, source_refs FROM knowledge_items")
        .all() as { id: unknown; kind: unknown; source_refs: unknown }[]) {
        // A journal cites sources but is not an import association to rewrite.
        if (row.kind === "journal") continue;
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
         WHERE record_kind = ? AND record_id = ? AND status <> 'rejected'
         ORDER BY project_id, origin`,
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
       WHERE record_kind = ? AND record_id = ? AND status = 'proposed'
       ORDER BY suggested_name, id`,
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
export function copyLinkedAssociations(
  db: DatabaseSync,
  fromKind: ProjectRecordKind,
  fromId: string,
  toKind: ProjectRecordKind,
  toId: string,
): void {
  const from = recordKindSchema.parse(fromKind);
  const to = recordKindSchema.parse(toKind);
  identifierSchema.parse(fromId);
  identifierSchema.parse(toId);
  db.prepare(
    `INSERT OR IGNORE INTO project_associations
      (record_kind, record_id, project_id, origin, status)
     SELECT ?, ?, project_id, origin, 'linked'
     FROM project_associations
     WHERE record_kind = ? AND record_id = ?
       AND origin IN ('configured', 'client') AND status = 'linked'`,
  ).run(to, toId, from, fromId);
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
    // Not a project id. remember and search reject it until the owner assigns one.
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

// ADR 0012. The owner writes the only profile. The processor never does.
export const profileByteLimit = 2048;
export const maxPinnedDecisions = 8;
const pinnedSchema = z
  .array(identifierSchema)
  .max(maxPinnedDecisions)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Duplicate pinned decision",
  });
export interface ProjectProfile {
  readonly id: string;
  readonly projectId: string;
  readonly homeArea: string;
  readonly purpose: string;
  readonly rules: string;
  readonly pinned: readonly string[];
  readonly inForce: readonly { readonly id: string; readonly text: string }[];
}
export class ProfileTooLarge extends Error {
  constructor() {
    super("Profile exceeds 2048 UTF-8 bytes");
    this.name = "ProfileTooLarge";
  }
}
export class InvalidPin extends Error {
  constructor(readonly id: string) {
    super(`Pinned id is not a decision in the project home area: ${id}`);
    this.name = "InvalidPin";
  }
}
export function profileId(projectId: string): string {
  return `profile:${projectIdSchema.parse(projectId)}`;
}
export function profileDocument(
  purpose: string,
  rules: string,
  pinned: readonly string[],
): string {
  return [purpose, rules, ...pinned].join("\n");
}
function knowledgeReady(db: DatabaseSync): boolean {
  return !!db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_items'",
    )
    .get();
}
function assertPinned(
  db: DatabaseSync,
  projectId: string,
  homeArea: string,
  ids: readonly string[],
): void {
  if (!ids.length) return;
  for (const id of ids) {
    const found =
      knowledgeReady(db) &&
      db
        .prepare(
          `SELECT 1 AS ok FROM knowledge_items k
           WHERE k.id = ? AND k.scope = ? AND k.kind = 'decision'
             AND EXISTS (
               SELECT 1 FROM project_associations pa
               WHERE pa.record_kind = 'knowledge' AND pa.record_id = k.id
                 AND pa.project_id = ? AND pa.status = 'linked'
             )`,
        )
        .get(id, homeArea, projectId);
    if (!found) throw new InvalidPin(id);
  }
}
function decisionsInForce(
  db: DatabaseSync,
  homeArea: string,
  ids: readonly string[],
): { id: string; text: string }[] {
  if (!ids.length || !knowledgeReady(db)) return [];
  const inForce: { id: string; text: string }[] = [];
  for (const id of ids) {
    const row = db
      .prepare(
        `SELECT k.text AS text,
          ${latestReviewStatusSql("k.id", "k.scope", "proposed")} AS status
         FROM knowledge_items k
         WHERE k.id = ? AND k.scope = ? AND k.kind = 'decision'`,
      )
      .get(id, homeArea) as { text?: unknown; status?: unknown } | undefined;
    if (!row || row.status !== "approved") continue;
    const superseded = db
      .prepare(
        `SELECT 1 AS ok FROM knowledge_relations
         WHERE scope = ? AND kind = 'supersedes' AND to_id = ?`,
      )
      .get(homeArea, id);
    if (superseded) continue;
    inForce.push({ id, text: String(row.text) });
  }
  return inForce;
}
function readProfileRow(
  db: DatabaseSync,
  projectId: string,
): ProjectProfile | undefined {
  const row = db
    .prepare(
      `SELECT p.home_area AS homeArea, f.purpose, f.rules, f.pinned
       FROM project_profiles f JOIN projects p ON p.id = f.project_id
       WHERE f.project_id = ?`,
    )
    .get(projectId) as
    | {
        homeArea: string;
        purpose: string;
        rules: string;
        pinned: string;
      }
    | undefined;
  if (!row) return undefined;
  const pinned = pinnedSchema.parse(JSON.parse(row.pinned));
  return {
    id: profileId(projectId),
    projectId,
    homeArea: row.homeArea,
    purpose: row.purpose,
    rules: row.rules,
    pinned,
    inForce: decisionsInForce(db, row.homeArea, pinned),
  };
}
export function setProjectProfile(
  db: DatabaseSync,
  input: {
    projectId: string;
    purpose: string;
    rules: string;
    pinned?: readonly string[];
  },
): ProjectProfile {
  const projectId = projectIdSchema.parse(input.projectId);
  const purpose = nonblankText(profileByteLimit).parse(input.purpose);
  const rules = nonblankText(profileByteLimit).parse(input.rules);
  const pinned = pinnedSchema.parse([...(input.pinned ?? [])]);
  const document = profileDocument(purpose, rules, pinned);
  if (Buffer.byteLength(document, "utf8") > profileByteLimit)
    throw new ProfileTooLarge();
  return write(db, () => {
    const home = db
      .prepare("SELECT home_area AS homeArea FROM projects WHERE id = ?")
      .get(projectId) as { homeArea?: unknown } | undefined;
    if (!home) throw new UnknownProject([projectId]);
    const homeArea = String(home.homeArea);
    assertPinned(db, projectId, homeArea, pinned);
    db.prepare(
      `INSERT INTO project_profiles (project_id, purpose, rules, pinned, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
        purpose = excluded.purpose,
        rules = excluded.rules,
        pinned = excluded.pinned,
        updated_at = excluded.updated_at`,
    ).run(
      projectId,
      purpose,
      rules,
      JSON.stringify(pinned),
      new Date().toISOString(),
    );
    const profile = readProfileRow(db, projectId);
    if (!profile) throw new Error("Missing project profile");
    return profile;
  });
}
export function getProjectProfile(
  db: DatabaseSync,
  projectId: string,
): ProjectProfile | undefined {
  const id = projectIdSchema.parse(projectId);
  if (!projectRow(db, id)) throw new UnknownProject([id]);
  return readProfileRow(db, id);
}
export function clearProjectProfile(db: DatabaseSync, projectId: string): void {
  const id = projectIdSchema.parse(projectId);
  write(db, () => {
    if (!projectRow(db, id)) throw new UnknownProject([id]);
    db.prepare("DELETE FROM project_profiles WHERE project_id = ?").run(id);
  });
}
export const maxGlossaryTerms = 32;
export const maxGlossarySynonyms = 8;
const glossaryPhrase = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    const words = phraseWords(value);
    const phrase = words.join(" ");
    if (
      words.length < 1 ||
      words.length > maxGlossaryWords ||
      phrase !== value.trim().toLowerCase().replaceAll(/\s+/gu, " ") ||
      words.some((word) => !/^[\p{L}\p{N}]+$/u.test(word))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Glossary phrases are one to four words",
      });
      return z.NEVER;
    }
    return phrase;
  });
export interface ProjectGlossaryEntry {
  readonly term: string;
  readonly synonyms: readonly string[];
}
function parseSynonyms(stored: string): string[] {
  const synonyms = z
    .array(glossaryPhrase)
    .min(1)
    .max(maxGlossarySynonyms)
    .parse(JSON.parse(stored));
  if (new Set(synonyms).size !== synonyms.length)
    throw new Error("Duplicate glossary synonym");
  return synonyms;
}
export function listProjectGlossary(
  db: DatabaseSync,
  projectId: string,
): ProjectGlossaryEntry[] {
  const id = projectIdSchema.parse(projectId);
  if (!projectRow(db, id)) throw new UnknownProject([id]);
  return (
    db
      .prepare(
        `SELECT term, synonyms FROM project_glossary
         WHERE project_id = ? ORDER BY term`,
      )
      .all(id) as { term: string; synonyms: string }[]
  ).map((row) => ({ term: row.term, synonyms: parseSynonyms(row.synonyms) }));
}
export function setProjectGlossaryTerm(
  db: DatabaseSync,
  input: { projectId: string; term: string; synonyms: readonly string[] },
): ProjectGlossaryEntry {
  const projectId = projectIdSchema.parse(input.projectId);
  const term = glossaryPhrase.parse(input.term);
  const synonyms = z
    .array(glossaryPhrase)
    .min(1)
    .max(maxGlossarySynonyms)
    .parse([...input.synonyms]);
  if (new Set(synonyms).size !== synonyms.length)
    throw new Error("Duplicate glossary synonym");
  if (synonyms.includes(term)) throw new Error("Synonym repeats the term");
  return write(db, () => {
    if (!projectRow(db, projectId)) throw new UnknownProject([projectId]);
    const existing = db
      .prepare(
        "SELECT 1 AS ok FROM project_glossary WHERE project_id = ? AND term = ?",
      )
      .get(projectId, term);
    if (!existing) {
      const count = Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM project_glossary WHERE project_id = ?",
          )
          .get(projectId)?.n,
      );
      if (count >= maxGlossaryTerms) throw new Error("Glossary is full");
    }
    db.prepare(
      `INSERT INTO project_glossary (project_id, term, synonyms, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, term) DO UPDATE SET
         synonyms = excluded.synonyms,
         updated_at = excluded.updated_at`,
    ).run(projectId, term, JSON.stringify(synonyms), new Date().toISOString());
    return { term, synonyms };
  });
}
export function unsetProjectGlossaryTerm(
  db: DatabaseSync,
  projectId: string,
  term: string,
): void {
  const id = projectIdSchema.parse(projectId);
  const key = glossaryPhrase.parse(term);
  write(db, () => {
    if (!projectRow(db, id)) throw new UnknownProject([id]);
    const result = db
      .prepare("DELETE FROM project_glossary WHERE project_id = ? AND term = ?")
      .run(id, key);
    if (!result.changes) throw new Error("Glossary term not found");
  });
}
export function readProjectProfile(
  db: DatabaseSync,
  id: string,
  scope: string,
): ProjectProfile | undefined {
  if (!id.startsWith("profile:")) return undefined;
  const projectId = projectIdSchema.safeParse(id.slice("profile:".length));
  if (!projectId.success) return undefined;
  scopeSchema.parse(scope);
  const profile = readProfileRow(db, projectId.data);
  if (!profile || profile.homeArea !== scope) return undefined;
  return profile;
}
