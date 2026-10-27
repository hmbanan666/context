import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import {
  fetchGitHubEvidence,
  type GitHubEvidence,
  githubEvidenceSchema,
  githubTargetSchema,
} from "./github-evidence.js";
import type { KnowledgeStore } from "./knowledge.js";
import { IdempotencyConflict, type SourceStore } from "./store.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const workAuthorizationSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  idempotencyKey: identifier,
  intentId: identifier,
  approvalId: identifier,
  repository: githubTargetSchema.shape.repository,
  branch: githubTargetSchema.shape.branch,
  baseBranch: githubTargetSchema.shape.baseBranch,
  requiredChecks: githubTargetSchema.shape.requiredChecks,
  dispatch: z.literal(true),
  disclose: z.strictObject({
    intent: z.literal(true),
    sourceIds: z
      .array(identifier)
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
});
export type WorkAuthorization = z.infer<typeof workAuthorizationSchema>;
export const workReceiptSchema = z.strictObject({
  authorization: workAuthorizationSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type WorkReceipt = z.infer<typeof workReceiptSchema>;
export interface WorkRecord {
  readonly id: string;
  readonly scope: string;
  readonly createdAt: string;
  readonly reviewer: string;
  readonly receipt: WorkReceipt;
}
export interface WorkObservation {
  readonly id: string;
  readonly observedAt: string;
  readonly pullNumber: number;
  readonly evidence: GitHubEvidence | null;
  readonly error: "github_unavailable" | null;
}
export class WorkNotFound extends Error {}
export class WorkAuthorizationError extends Error {}
export class WorkContextTooLarge extends Error {}

export const workContextSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  id: identifier,
  maxBytes: z.number().int().min(1024).max(65536).default(65536),
});

// Field order is fixed, including nested disclosure; no caller JSON serialization is trusted.
export function workAuthorizationPayload(input: WorkAuthorization): Buffer {
  const a = workAuthorizationSchema.parse(input);
  return Buffer.from(
    JSON.stringify([
      "context-work-authorization-v1",
      a.version,
      a.scope,
      a.idempotencyKey,
      a.intentId,
      a.approvalId,
      a.repository,
      a.branch,
      a.baseBranch,
      a.requiredChecks,
      a.dispatch,
      a.disclose.intent,
      a.disclose.sourceIds,
    ]),
    "utf8",
  );
}

export function applyWorkAuthorization(
  store: WorkStore,
  input: unknown,
  trustedPublicKey: string | Buffer,
) {
  const receipt = workReceiptSchema.parse(input);
  const key = createPublicKey(trustedPublicKey);
  const signature = Buffer.from(receipt.signature, "base64");
  if (
    key.asymmetricKeyType !== "ed25519" ||
    signature.toString("base64") !== receipt.signature ||
    !verify(
      null,
      workAuthorizationPayload(receipt.authorization),
      key,
      signature,
    )
  )
    throw new WorkAuthorizationError("Invalid work authorization");
  const reviewer = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  return store.authorize(receipt, reviewer);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const workSelection =
  "SELECT id, scope, created_at AS createdAt, reviewer, receipt, fingerprint FROM work_authorizations";
const observationSelection =
  "SELECT id, observed_at AS observedAt, pull_number AS pullNumber, evidence, error FROM work_observations";
function decodeWork(row: Record<string, unknown>): WorkRecord {
  return {
    id: identifier.parse(row.id),
    scope: scopeSchema.parse(row.scope),
    createdAt: z.iso.datetime().parse(row.createdAt),
    reviewer: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(row.reviewer),
    receipt: workReceiptSchema.parse(JSON.parse(String(row.receipt))),
  };
}
function decodeObservation(row: Record<string, unknown>): WorkObservation {
  return {
    id: String(row.id),
    observedAt: String(row.observedAt),
    pullNumber: Number(row.pullNumber),
    evidence:
      row.evidence === null
        ? null
        : githubEvidenceSchema.parse(JSON.parse(String(row.evidence))),
    error:
      row.error === null
        ? null
        : z.literal("github_unavailable").parse(row.error),
  };
}

export class WorkStore {
  readonly #database: DatabaseSync;
  readonly #sources: SourceStore;
  readonly #knowledge: KnowledgeStore;
  constructor(path: string, sources: SourceStore, knowledge: KnowledgeStore) {
    this.#sources = sources;
    this.#knowledge = knowledge;
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS work_authorizations (
          id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, request_key TEXT NOT NULL,
          intent_id TEXT NOT NULL REFERENCES knowledge_items(id),
          approval_id TEXT NOT NULL REFERENCES knowledge_reviews(id),
          reviewer TEXT NOT NULL, receipt TEXT NOT NULL, fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL, UNIQUE(scope, request_key)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS work_scope ON work_authorizations(scope, id);
        CREATE TABLE IF NOT EXISTS work_observations (
          id TEXT PRIMARY KEY NOT NULL, work_id TEXT NOT NULL REFERENCES work_authorizations(id),
          request_key TEXT NOT NULL, pull_number INTEGER NOT NULL,
          evidence TEXT, error TEXT CHECK(error IS NULL OR error = 'github_unavailable'),
          observed_at TEXT NOT NULL, UNIQUE(work_id, request_key),
          CHECK((evidence IS NULL) <> (error IS NULL))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS work_observation_history ON work_observations(work_id);
        COMMIT;`);
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      this.#database.close();
      throw error;
    }
  }
  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  #approved(a: WorkAuthorization, reviewer: string) {
    const intent = this.#knowledge.find(a.intentId, a.scope);
    const history = this.#knowledge.history(a.intentId, a.scope);
    const approval = history.at(-1);
    if (
      intent?.kind !== "decision_proposal" ||
      intent.status !== "approved" ||
      approval?.status !== "approved" ||
      approval.id !== a.approvalId ||
      approval.reviewer !== reviewer
    )
      throw new WorkAuthorizationError(
        "Work requires current approved owner intent",
      );
    const expected = intent.sourceRefs.map((ref) => ref.sourceId).sort();
    if (
      JSON.stringify([...a.disclose.sourceIds].sort()) !==
      JSON.stringify(expected)
    )
      throw new WorkAuthorizationError(
        "Disclosure must name exactly the intent sources",
      );
    for (const ref of intent.sourceRefs) {
      const source = this.#sources.find(ref.sourceId, a.scope);
      if (
        !source ||
        (ref.quote !== undefined && !source.text.includes(ref.quote))
      )
        throw new WorkAuthorizationError("Missing scoped provenance");
    }
    return { intent, approval };
  }
  // Trusted local signature boundary only; MCP cannot authorize or refresh work.
  authorize(receipt: WorkReceipt, reviewer: string) {
    const parsed = workReceiptSchema.parse(receipt);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(reviewer);
    const a = parsed.authorization;
    return this.#transaction(() => {
      this.#approved(a, reviewer);
      const prior = this.#database
        .prepare(`${workSelection} WHERE scope = ? AND request_key = ?`)
        .get(a.scope, a.idempotencyKey);
      const fingerprint = hash([parsed, reviewer]);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new IdempotencyConflict("Conflicting authorization");
        return { work: decodeWork(prior), duplicate: true };
      }
      const id = randomUUID();
      this.#database
        .prepare(
          "INSERT INTO work_authorizations(id,scope,request_key,intent_id,approval_id,reviewer,receipt,fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          a.scope,
          a.idempotencyKey,
          a.intentId,
          a.approvalId,
          reviewer,
          JSON.stringify(parsed),
          fingerprint,
          new Date().toISOString(),
        );
      const work = this.find(id, a.scope);
      if (!work) throw new WorkNotFound();
      return { work, duplicate: false };
    });
  }
  find(id: string, scope: string): WorkRecord | undefined {
    identifier.parse(id);
    scopeSchema.parse(scope);
    const row = this.#database
      .prepare(`${workSelection} WHERE id = ? AND scope = ?`)
      .get(id, scope);
    return row ? decodeWork(row) : undefined;
  }
  #prior(workId: string, requestKey: string, pullNumber: number) {
    const row = this.#database
      .prepare(`${observationSelection} WHERE work_id = ? AND request_key = ?`)
      .get(workId, requestKey);
    if (!row) return undefined;
    const observation = decodeObservation(row);
    if (observation.pullNumber !== pullNumber)
      throw new IdempotencyConflict("Conflicting refresh");
    return { observation, duplicate: true };
  }
  async refresh(
    id: string,
    scope: string,
    pullNumber: number,
    requestKey: string,
    fetcher: typeof fetch = fetch,
  ) {
    identifier.parse(requestKey);
    z.number().int().positive().max(2147483647).parse(pullNumber);
    const work = this.find(id, scope);
    if (!work) throw new WorkNotFound();
    const a = work.receipt.authorization;
    this.#approved(a, work.reviewer);
    const prior = this.#prior(id, requestKey, pullNumber);
    if (prior) return prior;
    // Once observed, a work record cannot be rebound to a different pull request.
    const bound = this.#database
      .prepare(
        "SELECT pull_number FROM work_observations WHERE work_id = ? AND evidence IS NOT NULL LIMIT 1",
      )
      .get(id);
    if (bound && bound.pull_number !== pullNumber)
      throw new WorkAuthorizationError("PR already bound");
    let evidence: GitHubEvidence | null = null;
    try {
      evidence = await fetchGitHubEvidence(
        {
          repository: a.repository,
          branch: a.branch,
          baseBranch: a.baseBranch,
          requiredChecks: a.requiredChecks,
          pullNumber,
        },
        fetcher,
      );
    } catch {
      /* A failed fetch is durable evidence of uncertainty, not prior success. */
    }
    return this.#transaction(() => {
      this.#approved(a, work.reviewer);
      const raced = this.#prior(id, requestKey, pullNumber);
      if (raced) return raced;
      const binding = this.#database
        .prepare(
          "SELECT pull_number FROM work_observations WHERE work_id = ? AND evidence IS NOT NULL LIMIT 1",
        )
        .get(id);
      if (binding && binding.pull_number !== pullNumber)
        throw new WorkAuthorizationError("PR already bound");
      const observation: WorkObservation = {
        id: randomUUID(),
        observedAt: new Date().toISOString(),
        pullNumber,
        evidence,
        error: evidence ? null : "github_unavailable",
      };
      this.#database
        .prepare(
          "INSERT INTO work_observations(id,work_id,request_key,pull_number,evidence,error,observed_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          observation.id,
          id,
          requestKey,
          pullNumber,
          evidence ? JSON.stringify(evidence) : null,
          observation.error,
          observation.observedAt,
        );
      return { observation, duplicate: false };
    });
  }
  context(id: string, scope: string, maxBytes = 65536) {
    workContextSchema.parse({ version: 1, id, scope, maxBytes });
    const work = this.find(id, scope);
    if (!work) throw new WorkNotFound();
    const a = work.receipt.authorization;
    const intent = this.#knowledge.find(a.intentId, scope);
    const approval = this.#knowledge
      .history(a.intentId, scope)
      .find((event) => event.id === a.approvalId);
    if (!intent || !approval) throw new WorkNotFound();
    const sources = a.disclose.sourceIds.map((sourceId) => {
      const material = this.#sources.findMaterial(sourceId, scope);
      if (!material) throw new WorkNotFound();
      return material;
    });
    let authorizationActive = true;
    try {
      this.#approved(a, work.reviewer);
    } catch {
      authorizationActive = false;
    }
    const rows = this.#database
      .prepare(
        `${observationSelection} WHERE work_id = ? ORDER BY rowid DESC LIMIT 22`,
      )
      .all(id);
    const latest = rows[0] ? decodeObservation(rows[0]) : null;
    const evidence = latest?.evidence;
    const resultReason = !authorizationActive
      ? "authorization_inactive"
      : !latest
        ? "no_observation"
        : !evidence
          ? "github_unavailable"
          : Date.parse(evidence.createdAt) < Date.parse(work.createdAt)
            ? "pr_predates_authorization"
            : !evidence.merge || evidence.state !== "closed" || evidence.draft
              ? "pr_unmerged"
              : evidence.checks.state !== "passed"
                ? "ci_not_passed"
                : "merged_ci_passed";
    const context = {
      version: 1 as const,
      scope,
      work,
      intent,
      approval,
      sources,
      authorizationActive,
      latest,
      history: [] as WorkObservation[],
      historyTruncated: rows.length > 21,
      resultReason,
      result:
        resultReason === "merged_ci_passed"
          ? ("merged_ci_passed" as const)
          : ("unverified" as const),
      deployment: "unverified" as const,
      freshness: "historical_observation" as const,
    };
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > maxBytes)
      throw new WorkContextTooLarge();
    // Preserve the complete rationale and latest fact; omit only whole older observations.
    for (const row of rows.slice(1, 21)) {
      context.history.push(decodeObservation(row));
      if (Buffer.byteLength(JSON.stringify(context), "utf8") > maxBytes) {
        context.history.pop();
        context.historyTruncated = true;
        break;
      }
    }
    return context;
  }
  close(): void {
    this.#database.close();
  }
}
