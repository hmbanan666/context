import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCodexEvents } from "../src/codex-extractor.js";
import {
  JobStore,
  PROCESSING_LEASE_MS,
  PROCESSOR_VERSION,
  type ProcessingOutput,
  ProcessingValidationError,
} from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { ModelUnavailableError, processNext } from "../src/processor.js";
import { SourceStore } from "../src/store.js";

const scope = "synthetic:processor";
const fixture = {
  version: 1 as const,
  scope,
  idempotencyKey: "processor-source-001",
  text: "A violet lighthouse on the Moon could guide imaginary paper boats.",
  origin: "fixture:processor",
};
const output: ProcessingOutput = {
  items: [
    {
      kind: "idea",
      text: "Use a lunar lighthouse to guide paper boats.",
      quote: fixture.text,
    },
    {
      kind: "decision_proposal",
      text: "Consider imaginary paper boats for the synthetic lunar scene.",
      quote: "imaginary paper boats",
    },
  ],
};

async function withStores(
  operation: (stores: {
    path: string;
    sources: SourceStore;
    knowledge: KnowledgeStore;
    jobs: JobStore;
    advance: (milliseconds: number) => void;
    clock: () => number;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "context-processor-test-"));
  const path = join(directory, "context.db");
  let now = Date.parse("2026-10-27T12:00:00Z");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const clock = () => now;
  const jobs = new JobStore(path, clock);
  try {
    await operation({
      path,
      sources,
      knowledge,
      jobs,
      advance: (milliseconds) => {
        now += milliseconds;
      },
      clock,
    });
  } finally {
    jobs.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("one processing step persists grounded suggestions without changing or approving the source", async () => {
  await withStores(async ({ sources, knowledge, jobs }) => {
    const source = sources.capture(fixture).source;
    const queued = jobs.enqueue({
      version: 1,
      scope,
      sourceId: source.id,
      idempotencyKey: "process-001",
    }).job;
    let calls = 0;
    const completed = await processNext(
      sources,
      knowledge,
      jobs,
      scope,
      async (input) => {
        calls++;
        assert.deepEqual(input.source, source);
        assert.equal(input.processorVersion, "memory-v1");
        return output;
      },
    );
    assert.equal(completed?.id, queued.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.attempts, 1);
    assert.equal(completed?.resultIds.length, 2);
    assert.equal(calls, 1);
    for (const [index, id] of (completed?.resultIds ?? []).entries()) {
      const item = knowledge.find(id, scope);
      assert.equal(item?.status, "suggested");
      assert.equal(item?.creator.kind, "model");
      assert.equal(item?.creator.version, PROCESSOR_VERSION);
      assert.equal(item?.text, output.items[index]?.text);
      assert.deepEqual(item?.sourceRefs, [
        { sourceId: source.id, quote: output.items[index]?.quote },
      ]);
    }
    assert.deepEqual(sources.find(source.id, scope), source);
    assert.equal(
      await processNext(sources, knowledge, jobs, scope, async () => {
        throw new Error("Completed work must not run again");
      }),
      undefined,
    );
    assert.equal(knowledge.list(scope).length, 2);
  });
});

test("unavailable inference records a safe retry reason and preserves the original source", async () => {
  await withStores(async ({ sources, knowledge, jobs, advance }) => {
    const source = sources.capture(fixture).source;
    jobs.enqueue({
      version: 1,
      scope,
      sourceId: source.id,
      idempotencyKey: "retry-001",
    });
    const retry = await processNext(
      sources,
      knowledge,
      jobs,
      scope,
      async () => {
        throw new ModelUnavailableError(
          "Sensitive model diagnostic must not escape",
        );
      },
    );
    assert.equal(retry?.status, "queued");
    assert.equal(retry?.lastError, "model_unavailable");
    assert.equal(JSON.stringify(retry).includes("Sensitive"), false);
    assert.deepEqual(knowledge.list(scope), []);
    assert.deepEqual(sources.find(source.id, scope), source);
    assert.equal(
      await processNext(sources, knowledge, jobs, scope, async () => output),
      undefined,
    );
    advance(1000);
    const completed = await processNext(
      sources,
      knowledge,
      jobs,
      scope,
      async () => output,
    );
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.attempts, 2);
    assert.equal(completed?.lastError, undefined);
    assert.equal(knowledge.list(scope).length, 2);
  });
});

test("invalid quotes and schema output produce no knowledge or source changes", async () => {
  await withStores(async ({ sources, knowledge, jobs, advance }) => {
    const source = sources.capture(fixture).source;
    jobs.enqueue({
      version: 1,
      scope,
      sourceId: source.id,
      idempotencyKey: "invalid-001",
    });
    const badQuote = await processNext(
      sources,
      knowledge,
      jobs,
      scope,
      async () => ({
        items: [
          { kind: "idea", text: "Unsupported idea", quote: "Absent quote" },
        ],
      }),
    );
    assert.equal(badQuote?.lastError, "invalid_output");
    assert.deepEqual(knowledge.list(scope), []);
    advance(1000);
    const badSchema = await processNext(
      sources,
      knowledge,
      jobs,
      scope,
      async () => JSON.parse('{"items":[],"approved":true}'),
    );
    assert.equal(badSchema?.lastError, "invalid_output");
    assert.deepEqual(knowledge.list(scope), []);
    assert.deepEqual(sources.find(source.id, scope), source);
  });
});

test("a restarted worker replays durable output and partial writes without another inference or duplicates", async () => {
  await withStores(
    async ({ path, sources, knowledge, jobs, advance, clock }) => {
      const source = sources.capture(fixture).source;
      const queued = jobs.enqueue({
        version: 1,
        scope,
        sourceId: source.id,
        idempotencyKey: "crash-001",
      }).job;
      const claimed = jobs.claim(scope);
      assert.ok(claimed);
      jobs.saveOutput(queued.id, scope, claimed.leaseToken, output);
      const first = output.items[0];
      assert.ok(first);
      const partial = knowledge.add({
        version: 1,
        scope,
        idempotencyKey: `processing:${queued.id}:0`,
        kind: first.kind,
        text: first.text,
        sourceRefs: [{ sourceId: source.id, quote: first.quote }],
        creator: {
          kind: "model",
          name: "context-memory-processor",
          version: PROCESSOR_VERSION,
        },
      }).item;
      advance(PROCESSING_LEASE_MS + 1);
      const resumedSources = new SourceStore(path);
      const resumedKnowledge = new KnowledgeStore(path);
      const resumedJobs = new JobStore(path, clock);
      try {
        const completed = await processNext(
          resumedSources,
          resumedKnowledge,
          resumedJobs,
          scope,
          async () => {
            throw new Error("Persisted output must not trigger inference");
          },
        );
        assert.equal(completed?.status, "completed");
        assert.equal(completed?.attempts, 2);
        assert.equal(completed?.resultIds[0], partial.id);
        assert.equal(resumedKnowledge.list(scope).length, 2);
        assert.deepEqual(resumedSources.find(source.id, scope), source);
      } finally {
        resumedJobs.close();
        resumedKnowledge.close();
        resumedSources.close();
      }
    },
  );
});

test("processing never claims another scope or passes its source to an extractor", async () => {
  await withStores(async ({ sources, knowledge, jobs }) => {
    const source = sources.capture(fixture).source;
    const queued = jobs.enqueue({
      version: 1,
      scope,
      sourceId: source.id,
      idempotencyKey: "scope-001",
    }).job;
    let calls = 0;
    const denied = await processNext(
      sources,
      knowledge,
      jobs,
      "synthetic:other",
      async () => {
        calls++;
        return output;
      },
    );
    assert.equal(denied, undefined);
    assert.equal(calls, 0);
    assert.equal(jobs.find(queued.id, scope)?.attempts, 0);
    assert.deepEqual(knowledge.list(scope), []);
    await assert.rejects(() =>
      processNext(
        sources,
        knowledge,
        jobs,
        "private:forbidden",
        async () => output,
      ),
    );
  });
});

function streamWith(item: unknown, completed = true): string {
  return [
    { type: "thread.started", thread_id: "synthetic-thread" },
    { type: "turn.started" },
    { type: "item.completed", item },
    ...(completed
      ? [
          {
            type: "turn.completed",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]
      : []),
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

test("Codex stream parser requires one completed schema-conforming final message", () => {
  const events = streamWith({
    id: "item_1",
    type: "agent_message",
    text: JSON.stringify(output),
  });
  assert.deepEqual(parseCodexEvents(events), output);
  const [started, turnStarted, ...remaining] = events.split("\n");
  const reasoning = JSON.stringify({
    type: "item.completed",
    item: {
      id: "reason_1",
      type: "reasoning",
      text: "A bounded diagnostic summary, not extracted knowledge",
    },
  });
  assert.deepEqual(
    parseCodexEvents(
      [started, turnStarted, reasoning, ...remaining].join("\n"),
    ),
    output,
  );
  const warning = {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "error",
      message:
        "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.",
    },
  };
  const [thread, ...rest] = events.split("\n");
  assert.deepEqual(
    parseCodexEvents([thread, JSON.stringify(warning), ...rest].join("\n")),
    output,
  );
  assert.throws(
    () =>
      parseCodexEvents(
        streamWith(
          {
            id: "item_1",
            type: "agent_message",
            text: JSON.stringify(output),
          },
          false,
        ),
      ),
    ProcessingValidationError,
  );
});

test("Codex stream parser rejects tool events, unexpected errors, extra fields and oversized output", () => {
  for (const item of [
    { id: "tool_1", type: "mcp_tool_call", tool: "capture" },
    { id: "tool_1", type: "command_execution", command: "echo unsafe" },
    { id: "tool_1", type: "web_search", query: "unsafe" },
    { id: "error_1", type: "error", message: "Sensitive provider failure" },
    {
      id: "message_1",
      type: "agent_message",
      text: '{"items":[],"approved":true}',
    },
    { id: "message_1", type: "agent_message", text: "not JSON" },
  ]) {
    assert.throws(
      () => parseCodexEvents(streamWith(item)),
      ProcessingValidationError,
    );
  }
  assert.throws(
    () => parseCodexEvents("x".repeat(1024 * 1024 + 1)),
    ProcessingValidationError,
  );
  const valid = streamWith({
    id: "message_1",
    type: "agent_message",
    text: JSON.stringify(output),
  });
  assert.throws(
    () => parseCodexEvents(`${valid}\n{"type":"turn.started"}`),
    ProcessingValidationError,
  );
  assert.throws(
    () => parseCodexEvents('{"type":"turn.started"}'),
    ProcessingValidationError,
  );
});
