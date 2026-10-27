import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import { IdempotencyConflict } from "./store.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const nonblank = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value),
    );
export const enqueueProcessingSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  sourceId: identifier,
  idempotencyKey: identifier,
});
export const processingOutputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        kind: z.enum(["idea", "observation", "decision_proposal"]),
        text: nonblank(8192),
        quote: nonblank(1024),
      }),
    )
    .max(8),
});
const failureSchema = z.enum([
  "model_unavailable",
  "invalid_output",
  "processing_failed",
]);
export type EnqueueProcessingInput = z.infer<typeof enqueueProcessingSchema>;
export type ProcessingOutput = z.infer<typeof processingOutputSchema>;
export type ProcessingFailure = z.infer<typeof failureSchema>;
export const PROCESSOR_VERSION = "memory-v1";
export const PROCESSING_LEASE_MS = 180_000;
export const PROCESSING_MAX_ATTEMPTS = 3;

export interface ProcessingJob {
  readonly id: string;
  readonly sourceId: string;
  readonly scope: string;
  readonly processorVersion: typeof PROCESSOR_VERSION;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt?: string;
  readonly resultIds: string[];
  readonly lastError?: ProcessingFailure;
}
export interface ClaimedProcessingJob extends ProcessingJob {
  readonly output?: ProcessingOutput;
}
export class ProcessingSourceNotFound extends Error {}
export class ProcessingLeaseLost extends Error {}
export class ProcessingOutputConflict extends Error {}
export class ProcessingValidationError extends Error {}

const publicJobSchema = z.strictObject({
  id: identifier,
  sourceId: identifier,
  scope: scopeSchema,
  processorVersion: z.literal(PROCESSOR_VERSION),
  status: z.enum(["queued", "running", "completed", "failed"]),
  attempts: z.number().int().min(0).max(PROCESSING_MAX_ATTEMPTS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  nextAttemptAt: z.iso.datetime().optional(),
  resultIds: z.array(identifier).max(8),
  lastError: failureSchema.optional(),
});
const selection = `SELECT id, source_id AS sourceId, scope, processor_version AS processorVersion,
  status, attempts, created_at AS createdAt, updated_at AS updatedAt,
  next_attempt_at AS nextAttemptAt, result_ids AS resultIds, last_error AS lastError,
  output, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt FROM processing_jobs`;

function publicJob(row: Record<string, unknown>): ProcessingJob {
  const parsed = publicJobSchema.parse({
    id: row.id,
    sourceId: row.sourceId,
    scope: row.scope,
    processorVersion: row.processorVersion,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resultIds: JSON.parse(String(row.resultIds)),
    ...(row.nextAttemptAt === null
      ? {}
      : { nextAttemptAt: new Date(Number(row.nextAttemptAt)).toISOString() }),
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
  });
  // Omit absent optional properties rather than returning undefined over MCP.
  return {
    id: parsed.id,
    sourceId: parsed.sourceId,
    scope: parsed.scope,
    processorVersion: parsed.processorVersion,
    status: parsed.status,
    attempts: parsed.attempts,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    resultIds: parsed.resultIds,
    ...(parsed.nextAttemptAt === undefined
      ? {}
      : { nextAttemptAt: parsed.nextAttemptAt }),
    ...(parsed.lastError === undefined ? {} : { lastError: parsed.lastError }),
  };
}
function validateClock(now: number): number {
  return z
    .number()
    .int()
    .min(0)
    .max(8_640_000_000_000_000 - PROCESSING_LEASE_MS)
    .parse(now);
}
function validateLookup(id: string, scope: string): void {
  identifier.parse(id);
  scopeSchema.parse(scope);
}

export class JobStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => number;

  constructor(path: string, clock: () => number = Date.now) {
    this.#clock = clock;
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#database.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;",
      );
      this.#database
        .prepare("SELECT id, scope, text FROM sources LIMIT 1")
        .get();
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS processing_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          source_id TEXT NOT NULL REFERENCES sources(id),
          scope TEXT NOT NULL,
          processor_version TEXT NOT NULL CHECK(processor_version = 'memory-v1'),
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
          attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          next_attempt_at INTEGER,
          lease_token TEXT,
          lease_expires_at INTEGER,
          output TEXT,
          result_ids TEXT NOT NULL DEFAULT '[]',
          last_error TEXT CHECK(last_error IN ('model_unavailable', 'invalid_output', 'processing_failed')),
          CHECK((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
          CHECK((status = 'queued') = (next_attempt_at IS NOT NULL))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS processing_jobs_claim ON processing_jobs(scope, status, next_attempt_at, lease_expires_at);
        CREATE TABLE IF NOT EXISTS processing_requests (
          scope TEXT NOT NULL,
          request_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          job_id TEXT NOT NULL REFERENCES processing_jobs(id),
          PRIMARY KEY(scope, request_key)
        ) STRICT;
        COMMIT;
      `);
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      this.#database.close();
      throw error;
    }
  }

  #now(): number {
    return validateClock(this.#clock());
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

  enqueue(input: EnqueueProcessingInput): {
    job: ProcessingJob;
    duplicate: boolean;
  } {
    const request = enqueueProcessingSchema.parse(input);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          request.version,
          request.scope,
          request.sourceId,
          PROCESSOR_VERSION,
        ]),
      )
      .digest("hex");
    return this.#transaction(() => {
      const prior = this.#database
        .prepare(
          "SELECT fingerprint, job_id FROM processing_requests WHERE scope = ? AND request_key = ?",
        )
        .get(request.scope, request.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== hash)
          throw new IdempotencyConflict(
            "Idempotency key reused with different input",
          );
        const job = this.find(String(prior.job_id), request.scope);
        if (!job) throw new Error("Missing processing request result");
        return { job, duplicate: true };
      }
      const source = this.#database
        .prepare("SELECT id FROM sources WHERE id = ? AND scope = ?")
        .get(request.sourceId, request.scope);
      if (!source) throw new ProcessingSourceNotFound("Source unavailable");
      const id = randomUUID();
      const now = this.#now();
      const timestamp = new Date(now).toISOString();
      this.#database
        .prepare(`INSERT INTO processing_jobs(id, source_id, scope, processor_version, status, attempts, created_at, updated_at, next_attempt_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`)
        .run(
          id,
          request.sourceId,
          request.scope,
          PROCESSOR_VERSION,
          timestamp,
          timestamp,
          now,
        );
      this.#database
        .prepare(
          "INSERT INTO processing_requests(scope, request_key, fingerprint, job_id) VALUES (?, ?, ?, ?)",
        )
        .run(request.scope, request.idempotencyKey, hash, id);
      const job = this.find(id, request.scope);
      if (!job) throw new Error("Missing inserted processing job");
      return { job, duplicate: false };
    });
  }

  find(id: string, scope: string): ProcessingJob | undefined {
    validateLookup(id, scope);
    const row = this.#database
      .prepare(`${selection} WHERE id = ? AND scope = ?`)
      .get(id, scope);
    return row ? publicJob(row) : undefined;
  }

  list(scope: string, limit = 20): ProcessingJob[] {
    scopeSchema.parse(scope);
    z.number().int().min(1).max(20).parse(limit);
    return this.#database
      .prepare(
        `${selection} WHERE scope = ? ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(scope, limit)
      .map(publicJob);
  }

  claim(
    scope: string,
    now = this.#now(),
  ): { job: ClaimedProcessingJob; leaseToken: string } | undefined {
    scopeSchema.parse(scope);
    validateClock(now);
    return this.#transaction(() => {
      const timestamp = new Date(now).toISOString();
      // A final abandoned attempt becomes terminal instead of remaining stuck forever.
      this.#database
        .prepare(`UPDATE processing_jobs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        updated_at = ?, last_error = 'processing_failed'
        WHERE scope = ? AND status = 'running' AND lease_expires_at <= ? AND attempts >= ?`)
        .run(timestamp, scope, now, PROCESSING_MAX_ATTEMPTS);
      const available = this.#database
        .prepare(`${selection} WHERE scope = ? AND attempts < ? AND
        ((status = 'queued' AND next_attempt_at <= ?) OR (status = 'running' AND lease_expires_at <= ?))
        ORDER BY created_at, id LIMIT 1`)
        .get(scope, PROCESSING_MAX_ATTEMPTS, now, now);
      if (!available) return undefined;
      const id = String(available.id);
      const leaseToken = randomUUID();
      this.#database
        .prepare(`UPDATE processing_jobs SET status = 'running', attempts = attempts + 1,
        lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND scope = ?`)
        .run(leaseToken, now + PROCESSING_LEASE_MS, timestamp, id, scope);
      const row = this.#database
        .prepare(`${selection} WHERE id = ? AND scope = ?`)
        .get(id, scope);
      if (!row) throw new Error("Missing claimed processing job");
      return {
        job: {
          ...publicJob(row),
          ...(row.output === null
            ? {}
            : {
                output: processingOutputSchema.parse(
                  JSON.parse(String(row.output)),
                ),
              }),
        },
        leaseToken,
      };
    });
  }

  #leased(
    id: string,
    scope: string,
    leaseToken: string,
  ): Record<string, unknown> {
    validateLookup(id, scope);
    identifier.parse(leaseToken);
    const row = this.#database
      .prepare(
        `${selection} WHERE id = ? AND scope = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`,
      )
      .get(id, scope, leaseToken, this.#now());
    if (!row) throw new ProcessingLeaseLost("Processing lease unavailable");
    return row;
  }

  saveOutput(
    id: string,
    scope: string,
    leaseToken: string,
    output: ProcessingOutput,
  ): ProcessingJob {
    const parsed = processingOutputSchema.parse(output);
    return this.#transaction(() => {
      const job = this.#leased(id, scope, leaseToken);
      const source = this.#database
        .prepare("SELECT text FROM sources WHERE id = ? AND scope = ?")
        .get(String(job.sourceId), scope);
      if (!source) throw new ProcessingSourceNotFound("Source unavailable");
      if (
        parsed.items.some((item) => !String(source.text).includes(item.quote))
      ) {
        throw new ProcessingValidationError(
          "Output quote is absent from source",
        );
      }
      const serialized = JSON.stringify(parsed);
      if (job.output !== null && job.output !== serialized) {
        throw new ProcessingOutputConflict("Processing output is immutable");
      }
      if (job.output === null) {
        this.#database
          .prepare(
            "UPDATE processing_jobs SET output = ?, updated_at = ? WHERE id = ? AND scope = ?",
          )
          .run(serialized, new Date(this.#now()).toISOString(), id, scope);
      }
      const updated = this.find(id, scope);
      if (!updated) throw new Error("Missing saved processing job");
      return updated;
    });
  }

  complete(
    id: string,
    scope: string,
    leaseToken: string,
    knowledgeIds: readonly string[],
  ): ProcessingJob {
    const ids = z
      .array(identifier)
      .max(8)
      .refine((values) => new Set(values).size === values.length)
      .parse(knowledgeIds);
    return this.#transaction(() => {
      const job = this.#leased(id, scope, leaseToken);
      if (job.output === null)
        throw new ProcessingValidationError(
          "Persist output before completing processing",
        );
      const output = processingOutputSchema.parse(
        JSON.parse(String(job.output)),
      );
      if (ids.length !== output.items.length)
        throw new ProcessingValidationError(
          "Processing results do not match output",
        );
      for (const [index, item] of output.items.entries()) {
        const result = this.#database
          .prepare(
            "SELECT kind, text, source_refs, creator FROM knowledge_items WHERE id = ? AND scope = ?",
          )
          .get(ids[index] ?? "", scope);
        if (!result)
          throw new ProcessingValidationError("Processing result unavailable");
        const creator = z
          .strictObject({
            kind: z.enum(["model", "user"]),
            name: nonblank(128),
            version: nonblank(128).optional(),
          })
          .parse(JSON.parse(String(result.creator)));
        const expectedRefs = [
          { sourceId: String(job.sourceId), quote: item.quote },
        ];
        if (
          result.kind !== item.kind ||
          result.text !== item.text ||
          creator.kind !== "model" ||
          creator.version !== PROCESSOR_VERSION ||
          JSON.stringify(JSON.parse(String(result.source_refs))) !==
            JSON.stringify(expectedRefs)
        ) {
          throw new ProcessingValidationError(
            "Processing results do not match output",
          );
        }
      }
      this.#database
        .prepare(`UPDATE processing_jobs SET status = 'completed', result_ids = ?, updated_at = ?,
        lease_token = NULL, lease_expires_at = NULL, last_error = NULL WHERE id = ? AND scope = ?`)
        .run(
          JSON.stringify(ids),
          new Date(this.#now()).toISOString(),
          id,
          scope,
        );
      const completed = this.find(id, scope);
      if (!completed) throw new Error("Missing completed processing job");
      return completed;
    });
  }

  fail(
    id: string,
    scope: string,
    leaseToken: string,
    reason: ProcessingFailure,
  ): ProcessingJob {
    const failure = failureSchema.parse(reason);
    return this.#transaction(() => {
      const job = this.#leased(id, scope, leaseToken);
      const now = this.#now();
      const exhausted = Number(job.attempts) >= PROCESSING_MAX_ATTEMPTS;
      const nextAttemptAt = exhausted
        ? null
        : now + 1000 * 2 ** (Number(job.attempts) - 1);
      this.#database
        .prepare(`UPDATE processing_jobs SET status = ?, next_attempt_at = ?, updated_at = ?,
        lease_token = NULL, lease_expires_at = NULL, last_error = ? WHERE id = ? AND scope = ?`)
        .run(
          exhausted ? "failed" : "queued",
          nextAttemptAt,
          new Date(now).toISOString(),
          failure,
          id,
          scope,
        );
      const updated = this.find(id, scope);
      if (!updated) throw new Error("Missing failed processing job");
      return updated;
    });
  }

  close(): void {
    this.#database.close();
  }
}
