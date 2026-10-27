import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import {
  enqueueProcessingSchema,
  JobStore,
  PROCESSING_LEASE_MS,
  PROCESSOR_VERSION,
  ProcessingLeaseLost,
  type ProcessingOutput,
  ProcessingOutputConflict,
  ProcessingSourceNotFound,
  ProcessingValidationError,
  processingOutputSchema,
} from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { IdempotencyConflict, SourceStore } from "../src/store.js";

const scope = "synthetic:jobs";
const output: ProcessingOutput = {
  items: [
    {
      kind: "observation",
      text: "The synthetic source mentions a violet lamp.",
      quote: "violet lamp",
    },
    {
      kind: "decision_proposal",
      text: "Test the synthetic lamp before planting.",
      quote: "test the violet lamp before planting",
    },
  ],
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "context-jobs-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const source = sources.capture({
    version: 1,
    scope,
    text: "Synthetic garden: test the violet lamp before planting.",
    origin: "fixture:jobs",
    idempotencyKey: "source-1",
  }).source;
  const foreign = sources.capture({
    version: 1,
    scope: "synthetic:other-project",
    text: source.text,
    origin: "fixture:jobs",
    idempotencyKey: "source-1",
  }).source;
  const knowledge = new KnowledgeStore(path);
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  const clock = () => now;
  const advance = (milliseconds: number) => {
    now += milliseconds;
  };
  const jobs = new JobStore(path, clock);
  const input = {
    version: 1 as const,
    scope,
    sourceId: source.id,
    idempotencyKey: "processing-1",
  };
  return {
    directory,
    path,
    sources,
    source,
    foreign,
    knowledge,
    jobs,
    input,
    clock,
    advance,
  };
}
function saveKnowledge(
  store: KnowledgeStore,
  sourceId: string,
  items: ProcessingOutput["items"],
  key: string,
  targetScope = scope,
) {
  return items.map(
    (item, index) =>
      store.add({
        version: 1,
        scope: targetScope,
        idempotencyKey: `${key}:${index}`,
        kind: item.kind,
        text: item.text,
        sourceRefs: [{ sourceId, quote: item.quote }],
        creator: {
          kind: "model",
          name: "synthetic-processor",
          version: PROCESSOR_VERSION,
        },
      }).item.id,
  );
}

test("enqueue is scoped and idempotent after restart without consuming keys on invalid source input", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.jobs.enqueue({ ...f.input, sourceId: f.foreign.id }),
      ProcessingSourceNotFound,
    );
    assert.throws(
      () => f.jobs.enqueue({ ...f.input, sourceId: "missing" }),
      ProcessingSourceNotFound,
    );
    assert.equal(
      enqueueProcessingSchema.safeParse({ ...f.input, command: "anything" })
        .success,
      false,
    );
    assert.equal(
      enqueueProcessingSchema.safeParse({ ...f.input, model: "anything" })
        .success,
      false,
    );
    const saved = f.jobs.enqueue(f.input);
    assert.equal(saved.job.status, "queued");
    assert.equal(saved.job.attempts, 0);
    assert.equal(saved.job.processorVersion, "memory-v1");
    assert.deepEqual(saved.job.resultIds, []);
    assert.equal("leaseToken" in saved.job, false);
    assert.equal("output" in saved.job, false);
    assert.deepEqual(f.jobs.enqueue(f.input), {
      job: saved.job,
      duplicate: true,
    });
    assert.throws(
      () => f.jobs.enqueue({ ...f.input, sourceId: f.foreign.id }),
      IdempotencyConflict,
    );
    assert.equal(f.jobs.find(saved.job.id, f.foreign.scope), undefined);
    assert.deepEqual(f.jobs.list(f.foreign.scope), []);
    assert.equal(f.jobs.claim(f.foreign.scope), undefined);
    f.jobs.close();
    const reopened = new JobStore(f.path, f.clock);
    try {
      assert.deepEqual(reopened.enqueue(f.input), {
        job: saved.job,
        duplicate: true,
      });
      assert.deepEqual(reopened.list(scope), [saved.job]);
      assert.throws(() => reopened.list(scope, 21));
    } finally {
      reopened.close();
    }
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("independent workers cannot share an active lease and stale workers cannot mutate reclaimed jobs", async () => {
  const f = await fixture();
  const secondWorker = new JobStore(f.path, f.clock);
  try {
    const saved = f.jobs.enqueue(f.input).job;
    const first = f.jobs.claim(scope);
    assert.ok(first);
    assert.equal(first.job.attempts, 1);
    assert.equal(secondWorker.claim(scope), undefined);
    f.advance(PROCESSING_LEASE_MS);
    const replacement = secondWorker.claim(scope);
    assert.ok(replacement);
    assert.equal(replacement.job.id, saved.id);
    assert.equal(replacement.job.attempts, 2);
    assert.notEqual(first.leaseToken, replacement.leaseToken);
    assert.throws(
      () => f.jobs.saveOutput(saved.id, scope, first.leaseToken, output),
      ProcessingLeaseLost,
    );
    assert.throws(
      () => f.jobs.fail(saved.id, scope, first.leaseToken, "processing_failed"),
      ProcessingLeaseLost,
    );
    assert.throws(
      () => f.jobs.complete(saved.id, scope, first.leaseToken, []),
      ProcessingLeaseLost,
    );
    assert.equal(f.jobs.claim(scope), undefined);
    assert.equal("leaseToken" in (f.jobs.find(saved.id, scope) ?? {}), false);
  } finally {
    secondWorker.close();
    f.jobs.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("simultaneous independent worker threads claim a queued job exactly once", async () => {
  const f = await fixture();
  const workers: Worker[] = [];
  try {
    const saved = f.jobs.enqueue(f.input).job;
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.module).then(({ JobStore }) => {
        const jobs = new JobStore(workerData.path, () => workerData.now);
        parentPort.once('message', () => {
          try { parentPort.postMessage(jobs.claim(workerData.scope)?.job.id ?? null); }
          finally { jobs.close(); }
        });
        parentPort.postMessage('ready');
      }).catch(error => { throw error; });
    `;
    for (let index = 0; index < 2; index++) {
      workers.push(
        new Worker(workerCode, {
          eval: true,
          workerData: {
            path: f.path,
            scope,
            now: f.clock(),
            module: new URL("../src/jobs.js", import.meta.url).href,
          },
        }),
      );
    }
    await Promise.all(workers.map((worker) => once(worker, "message")));
    const results = workers.map((worker) => once(worker, "message"));
    for (const worker of workers) worker.postMessage("claim");
    const values = (await Promise.all(results)).map(([value]) => value);
    assert.equal(values.filter((value) => value === saved.id).length, 1);
    assert.equal(values.filter((value) => value === null).length, 1);
    assert.equal(f.jobs.find(saved.id, scope)?.attempts, 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    f.jobs.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("validated output is immutable, survives retries, and cannot complete without matching grounded knowledge", async () => {
  const f = await fixture();
  try {
    const saved = f.jobs.enqueue(f.input).job;
    const claimed = f.jobs.claim(scope);
    assert.ok(claimed);
    const firstItem = output.items[0];
    assert.ok(firstItem);
    assert.throws(
      () => f.jobs.complete(saved.id, scope, claimed.leaseToken, []),
      ProcessingValidationError,
    );
    assert.throws(
      () =>
        f.jobs.saveOutput(saved.id, scope, claimed.leaseToken, {
          items: [{ ...firstItem, quote: "not in source" }],
        }),
      ProcessingValidationError,
    );
    for (const invalid of [
      {
        items: [
          {
            kind: "observation",
            text: "claim",
            quote: "violet lamp",
            status: "approved",
          },
        ],
      },
      {
        items: [{ kind: "observation", text: "\ud800", quote: "violet lamp" }],
      },
      { items: Array.from({ length: 9 }, () => output.items[0]) },
      { items: [{ kind: "observation", text: "claim", quote: " " }] },
    ])
      assert.equal(processingOutputSchema.safeParse(invalid).success, false);
    f.jobs.saveOutput(saved.id, scope, claimed.leaseToken, output);
    assert.doesNotThrow(() =>
      f.jobs.saveOutput(saved.id, scope, claimed.leaseToken, output),
    );
    assert.throws(
      () =>
        f.jobs.saveOutput(saved.id, scope, claimed.leaseToken, { items: [] }),
      ProcessingOutputConflict,
    );
    assert.equal("output" in (f.jobs.find(saved.id, scope) ?? {}), false);
    assert.throws(
      () =>
        f.jobs.complete(saved.id, scope, claimed.leaseToken, [
          "missing",
          "missing-again",
        ]),
      ProcessingValidationError,
    );
    const foreignIds = saveKnowledge(
      f.knowledge,
      f.foreign.id,
      output.items,
      "foreign",
      f.foreign.scope,
    );
    assert.throws(
      () => f.jobs.complete(saved.id, scope, claimed.leaseToken, foreignIds),
      ProcessingValidationError,
    );
    const ids = saveKnowledge(f.knowledge, f.source.id, output.items, "result");
    const [firstId, secondId] = ids;
    assert.ok(firstId);
    assert.ok(secondId);
    assert.throws(
      () =>
        f.jobs.complete(
          saved.id,
          scope,
          claimed.leaseToken,
          [...ids].reverse(),
        ),
      ProcessingValidationError,
    );
    assert.throws(
      () =>
        f.jobs.complete(saved.id, scope, claimed.leaseToken, [
          firstId,
          firstId,
        ]),
      /./,
    );
    f.jobs.fail(saved.id, scope, claimed.leaseToken, "processing_failed");
    assert.equal(f.jobs.claim(scope), undefined);
    f.advance(1000);
    const retry = f.jobs.claim(scope);
    assert.ok(retry);
    assert.deepEqual(retry.job.output, output);
    const completed = f.jobs.complete(saved.id, scope, retry.leaseToken, ids);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.resultIds, ids);
    assert.equal(completed.lastError, undefined);
    assert.equal("output" in completed, false);
    assert.equal(f.jobs.claim(scope), undefined);
    assert.equal(f.knowledge.find(secondId, scope)?.status, "suggested");
    assert.deepEqual(f.sources.find(f.source.id, scope), f.source);
  } finally {
    f.jobs.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("failed attempts use bounded backoff and abandoned final leases become terminal", async () => {
  const f = await fixture();
  try {
    const id = f.jobs.enqueue(f.input).job.id;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = f.jobs.claim(scope);
      assert.ok(claimed);
      assert.equal(claimed.job.attempts, attempt);
      const failed = f.jobs.fail(
        id,
        scope,
        claimed.leaseToken,
        "model_unavailable",
      );
      assert.equal(failed.lastError, "model_unavailable");
      assert.equal(failed.status, attempt === 3 ? "failed" : "queued");
      assert.equal(f.jobs.claim(scope), undefined);
      if (attempt < 3) {
        f.advance(1000 * 2 ** (attempt - 1) - 1);
        assert.equal(f.jobs.claim(scope), undefined);
        f.advance(1);
      }
    }
    f.advance(1_000_000);
    assert.equal(f.jobs.claim(scope), undefined);
    const abandoned = f.jobs.enqueue({
      ...f.input,
      idempotencyKey: "abandoned",
    }).job;
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(f.jobs.claim(scope)?.job.attempts, attempt);
      f.advance(PROCESSING_LEASE_MS);
    }
    assert.equal(f.jobs.claim(scope), undefined);
    assert.equal(f.jobs.find(abandoned.id, scope)?.status, "failed");
    assert.equal(f.jobs.find(abandoned.id, scope)?.attempts, 3);
    assert.equal(
      f.jobs.find(abandoned.id, scope)?.lastError,
      "processing_failed",
    );
  } finally {
    f.jobs.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("empty model output is a valid durable result and an expired lease cannot save or complete", async () => {
  const f = await fixture();
  try {
    const id = f.jobs.enqueue(f.input).job.id;
    const first = f.jobs.claim(scope);
    assert.ok(first);
    f.advance(PROCESSING_LEASE_MS);
    assert.throws(
      () => f.jobs.saveOutput(id, scope, first.leaseToken, { items: [] }),
      ProcessingLeaseLost,
    );
    assert.throws(
      () => f.jobs.complete(id, scope, first.leaseToken, []),
      ProcessingLeaseLost,
    );
    const second = f.jobs.claim(scope);
    assert.ok(second);
    f.jobs.saveOutput(id, scope, second.leaseToken, { items: [] });
    assert.equal(
      f.jobs.complete(id, scope, second.leaseToken, []).status,
      "completed",
    );
    assert.deepEqual(f.jobs.find(id, scope)?.resultIds, []);
  } finally {
    f.jobs.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("backup restore resumes saved output and partial knowledge writes without new model results or duplicate knowledge", async () => {
  const f = await fixture();
  try {
    const saved = f.jobs.enqueue(f.input).job;
    const claimed = f.jobs.claim(scope);
    assert.ok(claimed);
    f.jobs.saveOutput(saved.id, scope, claimed.leaseToken, output);
    const partialId = saveKnowledge(
      f.knowledge,
      f.source.id,
      output.items.slice(0, 1),
      "resume",
    )[0];
    const backup = join(f.directory, "snapshot.db");
    const restored = join(f.directory, "restored.db");
    await backupDatabase(f.path, backup);
    await restoreDatabase(backup, restored);
    const restoredSources = new SourceStore(restored);
    const restoredKnowledge = new KnowledgeStore(restored);
    const restoredJobs = new JobStore(restored, f.clock);
    try {
      assert.equal(restoredJobs.enqueue(f.input).duplicate, true);
      assert.equal(restoredJobs.enqueue(f.input).job.id, saved.id);
      assert.equal(restoredJobs.claim(scope), undefined);
      f.advance(PROCESSING_LEASE_MS);
      const resumed = restoredJobs.claim(scope);
      assert.ok(resumed);
      assert.deepEqual(resumed.job.output, output);
      assert.ok(resumed.job.output);
      const ids = saveKnowledge(
        restoredKnowledge,
        f.source.id,
        resumed.job.output.items,
        "resume",
      );
      assert.equal(ids[0], partialId);
      const completed = restoredJobs.complete(
        saved.id,
        scope,
        resumed.leaseToken,
        ids,
      );
      assert.equal(completed.status, "completed");
      assert.deepEqual(restoredJobs.enqueue(f.input), {
        job: completed,
        duplicate: true,
      });
      assert.equal(restoredKnowledge.list(scope).length, 2);
      assert.deepEqual(restoredSources.find(f.source.id, scope), f.source);
    } finally {
      restoredJobs.close();
      restoredKnowledge.close();
      restoredSources.close();
    }
  } finally {
    f.jobs.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
