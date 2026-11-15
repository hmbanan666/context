import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { nonblankText } from "./contracts.js";
import { projectIdSchema } from "./projects.js";

// A document is a source. Revisions stay immutable rows, as markdown import
// already does. This table names the current key and who set the status.
export const docTypes = ["adr", "spec", "note"] as const;
export type DocType = (typeof docTypes)[number];
export const adrStatuses = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
] as const;
export const specStatuses = ["draft", "active", "obsolete"] as const;
export const noteStatuses = ["active"] as const;
export const importDocumentActor = "import";

const docKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);

export const documentInputSchema = z
  .strictObject({
    type: z.enum(docTypes),
    key: docKeySchema,
    title: nonblankText(256),
    status: z.string().min(1).max(32).optional(),
  })
  .superRefine((doc, context) => {
    const allowed: readonly string[] =
      doc.type === "adr"
        ? adrStatuses
        : doc.type === "spec"
          ? specStatuses
          : noteStatuses;
    const status = doc.status ?? (doc.type === "note" ? "active" : undefined);
    if (!status || !allowed.includes(status)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `${doc.type} status must be ${allowed.join(", ")}`,
      });
    }
  });

export interface SourceDocument {
  readonly projectId: string;
  readonly type: DocType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly setBy: string;
}

export interface DocumentWrite {
  readonly projectId: string;
  readonly type: DocType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly setBy: string;
}

export interface DocumentRef {
  readonly projectId: string;
  readonly type: DocType;
  readonly key: string;
  readonly revision?: number;
}

export interface DocumentRevisionSummary {
  readonly revision: number;
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly setBy: string;
  readonly capturedAt: string;
}

export type DocumentInput = z.input<typeof documentInputSchema>;

export function parseDocument(
  input: z.input<typeof documentInputSchema>,
): Omit<DocumentWrite, "projectId" | "setBy"> {
  const doc = documentInputSchema.parse(input);
  return {
    type: doc.type,
    key: doc.key,
    title: doc.title,
    status: doc.status ?? "active",
  };
}

export function installDocuments(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_docs (
      source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
      project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 64),
      doc_type TEXT NOT NULL CHECK(doc_type IN ('adr', 'spec', 'note')),
      doc_key TEXT NOT NULL CHECK(length(doc_key) BETWEEN 1 AND 64),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 256),
      status TEXT NOT NULL CHECK(
        (doc_type = 'adr' AND status IN ('proposed', 'accepted', 'superseded', 'rejected'))
        OR (doc_type = 'spec' AND status IN ('draft', 'active', 'obsolete'))
        OR (doc_type = 'note' AND status = 'active')
      ),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      set_by TEXT NOT NULL CHECK(length(set_by) BETWEEN 1 AND 128)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS source_docs_revision
      ON source_docs(project_id, doc_type, doc_key, revision);
  `);
}

/** Older revisions of the same project, type and key. */
export const staleDocumentSourceSql = `s.id IN (
  SELECT d.source_id FROM source_docs d
  WHERE d.revision < (
    SELECT MAX(d2.revision) FROM source_docs d2
    WHERE d2.project_id = d.project_id
      AND d2.doc_type = d.doc_type
      AND d2.doc_key = d.doc_key
  )
)`;

export function currentDocumentSourceSql(typed: boolean): string {
  return `s.id IN (
    SELECT d.source_id FROM source_docs d
    WHERE d.revision = (
      SELECT MAX(d2.revision) FROM source_docs d2
      WHERE d2.project_id = d.project_id
        AND d2.doc_type = d.doc_type
        AND d2.doc_key = d.doc_key
    )${typed ? " AND d.doc_type = ?" : ""}
  )`;
}

/**
 * Accepted ADRs and active specs sort above an equal match.
 * Superseded, rejected and obsolete documents sort below one.
 */
export function adjustDocumentScore(
  score: number,
  doc: Pick<SourceDocument, "type" | "status">,
): number {
  if (
    (doc.type === "adr" && doc.status === "accepted") ||
    (doc.type === "spec" && doc.status === "active")
  )
    return score + 1;
  if (
    (doc.type === "adr" &&
      (doc.status === "superseded" || doc.status === "rejected")) ||
    (doc.type === "spec" && doc.status === "obsolete")
  )
    return score * 0.5;
  return score;
}

export function documentRefCandidates(id: string): DocumentRef[] {
  if (!id.startsWith("doc:")) return [];
  let body = id.slice("doc:".length);
  let revision: number | undefined;
  const suffix = /@([1-9][0-9]{0,8})$/u.exec(body);
  if (suffix?.[1] !== undefined && suffix.index !== undefined) {
    revision = Number(suffix[1]);
    body = body.slice(0, suffix.index);
  }
  const found: DocumentRef[] = [];
  const seen = new Set<string>();
  for (const type of docTypes) {
    const needle = `:${type}:`;
    let from = 0;
    while (from < body.length) {
      const index = body.indexOf(needle, from);
      if (index < 1) break;
      const projectId = body.slice(0, index);
      const key = body.slice(index + needle.length);
      if (
        projectIdSchema.safeParse(projectId).success &&
        docKeySchema.safeParse(key).success
      ) {
        const identity = `${projectId}\0${type}\0${key}\0${revision ?? ""}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          found.push({
            projectId,
            type,
            key,
            ...(revision !== undefined ? { revision } : {}),
          });
        }
      }
      from = index + 1;
    }
  }
  return found;
}
