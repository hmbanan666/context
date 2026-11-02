import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";
import { runTidy } from "../src/tidy.js";

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".output-tidy-"));
  const path = join(directory, "db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const add = (
    id: string,
    text: string,
    scope = "personal",
    capturedAt = "2026-01-01T00:00:00Z",
  ) => sources.insert({ id, text, scope, capturedAt, origin: "fixture" });
  return {
    directory,
    path,
    sources,
    knowledge,
    add,
    capture(text: string, createdAt: string) {
      return sources.captureMaterial({
        version: 1,
        scope: "personal",
        origin: "fixture",
        idempotencyKey: text.trim().replaceAll(" ", "-"),
        text,
        metadata: { createdAt },
      }).material.source;
    },
    async close() {
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("tidy without a key deduplicates within areas, preserves originals, and dry-run writes nothing", async () => {
  const f = await fixture();
  try {
    const copy = f.capture(
      "  Synthetic   lunar garden note  ",
      "2026-01-02T00:00:00Z",
    );
    const original = f.capture(
      "Synthetic lunar garden note",
      "2026-01-01T00:00:00Z",
    );
    f.add("foreign", original.text, "vault");
    const options = { databasePath: f.path, areas: ["personal", "vault"] };
    const dry = await runTidy({ ...options, dryRun: true });
    assert.equal(dry.duplicates, 1);
    assert.equal(dry.llm, "not_configured");
    assert.deepEqual(f.knowledge.relations("personal"), []);
    await assert.rejects(readFile(join(f.directory, "tidy/history.jsonl")));
    const run = await runTidy(options);
    assert.equal(run.duplicates, 1);
    assert.equal((await runTidy(options)).duplicates, 0);
    const [relation] = f.knowledge.relations("personal");
    assert.equal(relation?.fromId, copy.id);
    assert.equal(relation?.toId, original.id);
    assert.equal(f.knowledge.relations("vault").length, 0);
    assert.deepEqual(f.sources.find(copy.id, "personal"), copy);
    const history = await readFile(
      join(f.directory, "tidy/history.jsonl"),
      "utf8",
    );
    assert.ok(!history.includes("lunar"));
    assert.ok(JSON.parse(history.trim().split("\n")[0] ?? "").lastSuccessfulAt);
  } finally {
    await f.close();
  }
});

for (const [name, aDate, bDate, choice, skipped] of [
  ["batched imports", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "b", 0],
  ["equal dates", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "b", 0],
  [
    "exactly one minute apart",
    "2026-01-01T00:01:00Z",
    "2026-01-01T00:00:00Z",
    "b",
    0,
  ],
  [
    "older b contradicts clear dates",
    "2026-01-01T00:01:00.001Z",
    "2026-01-01T00:00:00Z",
    "b",
    1,
  ],
  [
    "older a contradicts clear dates",
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
    "a",
    1,
  ],
  ["no supersession", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", null, 0],
] as const) {
  test(`tidy uses effective dates and model direction: ${name}`, async (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-02-01T00:00:00Z"),
    });
    const f = await fixture();
    const index = new EmbeddingIndex(f.path, {
      version: "fixture",
      async embed() {
        return Float32Array.from([1, 0]);
      },
    });
    try {
      const current = f.capture("Synthetic lunar agents limit 4", bDate);
      const other = f.capture("Synthetic lunar agents limit 3", aDate);
      assert.equal(current.capturedAt, other.capturedAt);
      while (await index.processOne()) {
        /* synthetic vector preparation */
      }
      const run = await runTidy({
        databasePath: f.path,
        areas: ["personal"],
        embeddingModel: "fixture",
        llm: {
          model: "fake",
          async ask(_instruction: string, data: unknown) {
            assert.deepEqual(data, [
              {
                index: 0,
                a: { text: other.text, effectiveDate: aDate },
                b: { text: current.text, effectiveDate: bDate },
              },
            ]);
            return [{ index: 0, current: choice }];
          },
        },
      });
      assert.equal(run.failures, 0);
      assert.equal(run.outcome, "completed");
      assert.equal(run.skipped, skipped);
      const expected = choice !== null && !skipped;
      assert.equal(run.supersedes, expected ? 1 : 0);
      const relations = f.knowledge.relations("personal");
      assert.equal(relations.length, expected ? 1 : 0);
      if (expected) {
        assert.equal(relations[0]?.fromId, current.id);
        assert.equal(relations[0]?.toId, other.id);
      }
    } finally {
      await index.close();
      await f.close();
    }
  });
}

test("tidy windows use capture time so newly imported old notes are considered", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-01-02T00:00:00Z"),
  });
  const f = await fixture();
  const index = new EmbeddingIndex(f.path, {
    version: "fixture",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  let calls = 0;
  const options = {
    databasePath: f.path,
    areas: ["personal"],
    embeddingModel: "fixture",
    llm: {
      model: "fake",
      async ask(_instruction: string, data: unknown) {
        calls++;
        return (data as { index: number }[]).map(({ index }) => ({
          index,
          current: null,
        }));
      },
    },
  };
  try {
    assert.equal(
      (await runTidy(options)).lastSuccessfulAt,
      "2026-01-02T00:00:00.000Z",
    );
    t.mock.timers.setTime(Date.parse("2026-01-04T00:00:00Z"));
    f.add("fallback", "Synthetic lunar agents limit 1");
    f.capture("Synthetic lunar agents limit 2", "2026-01-01T00:00:00Z");
    f.capture("Synthetic lunar agents limit 3", "2026-01-03T00:00:00Z");
    f.capture("Synthetic lunar agents limit 4", "2026-01-05T00:00:00Z");
    f.add(
      "future-capture",
      "Synthetic lunar agents limit 5",
      "personal",
      "2026-01-05T00:00:00Z",
    );
    while (await index.processOne()) {
      /* synthetic vector preparation */
    }
    const run = await runTidy(options);
    // All three imports arrived Jan 4, including the old and future authored notes.
    // Their six pairs qualify; a future capture does not.
    assert.equal(run.pairs, 6);
    assert.equal(calls, 1);
    assert.equal(run.failures, 0);
    assert.equal(run.lastSuccessfulAt, "2026-01-04T00:00:00.000Z");
  } finally {
    await index.close();
    await f.close();
  }
});

test("tidy uses vectors for conservative dedup and model updates, retries failures without advancing success", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const f = await fixture();
  const index = new EmbeddingIndex(f.path, {
    version: "fixture",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  try {
    f.add("old", "Synthetic lunar agents limit 3");
    f.add(
      "new",
      "Synthetic lunar agents limit 4",
      "personal",
      "2026-01-02T00:00:00Z",
    );
    f.add(
      "copy",
      "Synthetic lunar agents limit 4!",
      "personal",
      "2026-01-03T00:00:00Z",
    );
    f.add("foreign", "Synthetic lunar agents limit 8", "vault");
    while (await index.processOne()) {
      /* synthetic vector preparation */
    }
    let invalid = true;
    let calls = 0;
    const llm = {
      model: "fake",
      async ask(_instruction: string, data: unknown) {
        calls++;
        assert.ok(!JSON.stringify(data).includes("limit 8"));
        return [{ index: 0, current: invalid ? "yes" : "a" }];
      },
    };
    const options = {
      databasePath: f.path,
      areas: ["personal"],
      embeddingModel: "fixture",
      llm,
    };
    const failed = await runTidy(options);
    assert.equal(failed.duplicates, 1);
    assert.equal(failed.failures, 1);
    assert.equal(failed.outcome, "partial");
    assert.equal(failed.lastSuccessfulAt, null);
    invalid = false;
    const run = await runTidy(options);
    assert.equal(run.supersedes, 1);
    const update = f.knowledge
      .relations("personal")
      .find((r) => r.kind === "supersedes");
    assert.equal(update?.fromId, "new");
    assert.equal(update?.toId, "old");
    assert.deepEqual(update?.creator, { kind: "model", name: "fake" });
    const before = calls;
    assert.equal((await runTidy(options)).supersedes, 0);
    assert.equal(calls, before);
  } finally {
    await index.close();
    await f.close();
  }
});

test("inbox moves confident sources atomically, leaves uncertain/derived sources, and prevents wider disclosure", async () => {
  const { AuthStore } = await import("../src/auth-store.js");
  const f = await fixture();
  const auth = new AuthStore(f.path, ["personal", "inbox", "vault"]);
  try {
    auth.createCliToken(
      "vault-reader",
      { read: ["vault"], write: [], process: [] },
      null,
      3600,
      "https://fixture.example/mcp",
    );
    const input = {
      version: 1 as const,
      scope: "inbox",
      idempotencyKey: "inbox-source",
      text: "Synthetic garden routing confident",
      origin: "fixture",
    };
    const source = f.sources.capture(input).source;
    const imported = f.sources.importMaterial(
      {
        ...input,
        idempotencyKey: "import",
        text: "Synthetic garden imported confident",
      },
      { source: "fixture", externalId: "one", metadata: {} },
    ).source;
    f.add("uncertain", "Synthetic ambiguous note", "inbox");
    const derived = f.add("derived", "Synthetic derived evidence", "inbox");
    f.knowledge.add({
      version: 1,
      scope: "inbox",
      idempotencyKey: "derived",
      kind: "idea",
      text: "A derived claim",
      sourceRefs: [{ sourceId: derived.id }],
      creator: { kind: "user", name: "fixture" },
    });
    const llm = {
      model: "fake",
      async ask(_instruction: string, data: unknown) {
        return (data as { index: number; text: string; areas: string[] }[]).map(
          (d) => {
            assert.ok(!d.areas.includes("vault"));
            return {
              index: d.index,
              area: "personal",
              confidence: d.text.includes("confident") ? 0.95 : 0.6,
            };
          },
        );
      },
    };
    const options = {
      databasePath: f.path,
      areas: ["inbox", "personal", "vault"],
      area: "inbox",
      llm,
    };
    assert.equal((await runTidy({ ...options, dryRun: true })).moved, 2);
    assert.ok(f.sources.find(source.id, "inbox"));
    const result = await runTidy(options);
    assert.equal(result.moved, 2);
    assert.equal(result.uncertain, 1);
    assert.equal(result.skipped, 1);
    assert.equal(f.sources.find(source.id, "inbox"), undefined);
    assert.equal(
      f.sources.find(source.id, "personal")?.checksum,
      source.checksum,
    );
    assert.equal(f.sources.search("confident", "inbox", 10).length, 0);
    assert.equal(f.sources.search("confident", "personal", 10).length, 2);
    assert.equal(
      f.sources.packageCandidates({
        scope: "inbox",
        terms: ["garden"],
        limit: 10,
      }).materials.length,
      0,
    );
    assert.equal(
      f.sources.packageCandidates({
        scope: "personal",
        terms: ["gardens"],
        limit: 10,
      }).materials.length,
      2,
    );
    assert.ok(f.sources.findMaterial(imported.id, "personal")?.import);
    assert.throws(() => f.sources.capture(input)); // Original-area retry cannot disclose the moved source.
    assert.equal((await runTidy(options)).moved, 0);
  } finally {
    auth.close();
    await f.close();
  }
});

test("tidy CLI dry-run reports synthetic counts without changing database bytes or creating history", async () => {
  const { spawnSync } = await import("node:child_process");
  const f = await fixture();
  try {
    f.add("original", "Synthetic dry run note");
    f.add("copy", "Synthetic dry run note", "personal", "2026-01-02T00:00:00Z");
    const before = await readFile(f.path);
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/context.js",
        "tidy",
        "--dry-run",
        "--json",
        "--area",
        "personal",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CONTEXT_DB_PATH: f.path,
          CONTEXT_AREAS: "personal,vault",
          CONTEXT_PROCESSOR: "openai",
          CONTEXT_LLM_API_KEY: "",
          CONTEXT_LLM_MODEL: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.duplicates, 1);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.llm, "not_configured");
    assert.equal(summary.llmCalls, 0);
    assert.equal(summary.processor, "openai");
    assert.deepEqual(await readFile(f.path), before);
    await assert.rejects(readFile(join(f.directory, "tidy/history.jsonl")));
  } finally {
    await f.close();
  }
});

test("capped model pairs resume and missing vectors do not advance the successful watermark", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const f = await fixture();
  const index = new EmbeddingIndex(f.path, {
    version: "fixture",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  try {
    for (let i = 1; i <= 21; i++)
      f.add(`fact-${i}`, `Synthetic lunar agents limit ${i}`);
    let calls = 0;
    const options = {
      databasePath: f.path,
      areas: ["personal"],
      embeddingModel: "fixture",
      llm: {
        model: "fake",
        async ask(_instruction: string, data: unknown) {
          calls++;
          return (data as { index: number }[]).map(({ index }) => ({
            index,
            current: null,
          }));
        },
      },
    };
    const pending = await runTidy(options);
    assert.equal(pending.lastSuccessfulAt, null);
    assert.equal(pending.vectorsMissing, 21);
    while (await index.processOne()) {
      /* synthetic preparation */
    }
    const first = await runTidy(options);
    assert.equal(first.pairs, 200);
    assert.equal(first.capped, true);
    assert.equal(first.lastSuccessfulAt, null);
    const second = await runTidy(options);
    assert.equal(second.pairs, 10);
    assert.equal(second.capped, false);
    assert.ok(second.lastSuccessfulAt);
    assert.equal(calls, 9);
    assert.equal((await runTidy(options)).pairs, 0);
  } finally {
    await index.close();
    await f.close();
  }
});

test("near-duplicate cosine gate is conservative and concurrent reruns add one relation", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const f = await fixture();
  const index = new EmbeddingIndex(f.path, {
    version: "fixture",
    async embed(text) {
      const score = text.endsWith("!") ? 0.971 : text.endsWith("?") ? 0.969 : 1;
      return Float32Array.from([score, Math.sqrt(1 - score * score)]);
    },
  });
  try {
    f.add(
      "original",
      "Synthetic lunar garden keeps a detailed daily maintenance journal",
    );
    f.add(
      "below",
      "Synthetic lunar garden keeps a detailed daily maintenance journal?",
      "personal",
      "2026-01-02T00:00:00Z",
    );
    f.add(
      "above",
      "Synthetic lunar garden keeps a detailed daily maintenance journal!",
      "personal",
      "2026-01-03T00:00:00Z",
    );
    while (await index.processOne()) {
      /* synthetic preparation */
    }
    const options = {
      databasePath: f.path,
      areas: ["personal"],
      embeddingModel: "fixture",
    };
    const runs = await Promise.all([runTidy(options), runTidy(options)]);
    assert.equal(
      runs.reduce((n, r) => n + r.duplicates, 0),
      1,
    );
    const links = f.knowledge.relations("personal");
    assert.equal(links.length, 1);
    assert.equal(links[0]?.fromId, "above");
    assert.equal(links[0]?.toId, "original");
    assert.ok(f.sources.find("below", "personal"));
  } finally {
    await index.close();
    await f.close();
  }
});

for (const processor of ["codex", "openai"] as const) {
  test(`${processor} batches both jobs within 12 calls and resumes untouched work`, async () => {
    const { createLlm } = await import("../src/llm.js");
    const { fakeCodex } = await import("./fake-codex.js");
    const fake = await fakeCodex(`
assert.ok(Array.isArray(data) && data.length <= 25);
fs.appendFileSync(process.env.HOME + '/calls.jsonl', JSON.stringify(data) + '\\n');
respond(data.map(({index, a}) => a ? {index, current:null} : {index, area:null, confidence:0}));
`);
    const f = await fixture();
    const index = new EmbeddingIndex(f.path, {
      version: "fixture",
      async embed() {
        return Float32Array.from([1, 0]);
      },
    });
    const apiBatches: unknown[][] = [];
    try {
      for (let i = 1; i <= 21; i++)
        f.add(`fact-${i}`, `Synthetic lunar limit ${i}`);
      // Long inbox sources are sorted but are not short-fact supersede candidates.
      for (let i = 1; i <= 110; i++)
        f.add(
          `inbox-${i}`,
          `Synthetic inbox ${i} ${"note ".repeat(301)}`,
          "inbox",
        );
      while (await index.processOne()) {
        /* synthetic vector preparation */
      }
      const llm = createLlm(
        {
          ...fake.env,
          CONTEXT_PROCESSOR: processor,
          CONTEXT_LLM_MODEL: "fixture",
          CONTEXT_LLM_API_KEY: "synthetic",
        },
        async (_url, init) => {
          const data = JSON.parse(
            JSON.parse(String(init?.body)).messages[1].content,
          ) as { index: number; a?: unknown }[];
          apiBatches.push(data);
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    data.map(({ index, a }) =>
                      a
                        ? { index, current: null }
                        : { index, area: null, confidence: 0 },
                    ),
                  ),
                },
              },
            ],
          });
        },
      );
      assert.ok(llm);
      const options = {
        databasePath: f.path,
        areas: ["inbox", "personal"],
        embeddingModel: "fixture",
        llm,
      };
      const first = await runTidy(options);
      assert.equal(first.processor, processor);
      assert.equal(first.llmCalls, 12);
      assert.equal(first.capped, true);
      assert.equal(first.uncertain, 110);
      assert.equal(first.pairs, 175);
      assert.equal(first.failures, 0);
      const second = await runTidy(options);
      assert.equal(second.llmCalls, 2);
      assert.equal(second.pairs, 35);
      assert.equal(second.uncertain, 0);
      assert.equal(second.capped, false);
      assert.ok(second.lastSuccessfulAt);
      assert.equal(second.windowEnd, first.windowEnd);
      const batches: unknown[][] =
        processor === "codex"
          ? (await readFile(join(fake.directory, "calls.jsonl"), "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : apiBatches;
      assert.equal(batches.length, 14);
      assert.ok(batches.every((batch) => batch.length <= 25));
      assert.equal(batches.flat().length, 320);
      assert.equal(
        new Set(batches.flat().map((item) => JSON.stringify(item))).size,
        320,
      );
      const history = await readFile(
        join(f.directory, "tidy/history.jsonl"),
        "utf8",
      );
      assert.ok(!history.includes("Synthetic"));
      assert.equal(JSON.parse(history.split("\n")[0] ?? "").llmCalls, 12);
    } finally {
      await index.close();
      await f.close();
      await fake.close();
    }
  });
}

for (const [name, body] of [
  ["invalid JSON", "console.log('not-json synthetic-private-diagnostic');"],
  [
    "not logged in",
    "console.error('synthetic-private-diagnostic'); process.exit(1);",
  ],
  ["timeout", "setInterval(() => {}, 1000);"],
  ["oversized output", "console.log('x'.repeat(256 * 1024));"],
  ["missing binary", ""],
]) {
  test(`Codex ${name} falls back to dedup without exposing diagnostics or changing sources`, async () => {
    const { createCodexLlm } = await import("../src/codex-llm.js");
    const { fakeCodex } = await import("./fake-codex.js");
    const fake = await fakeCodex(body ?? "");
    const f = await fixture();
    const index = new EmbeddingIndex(f.path, {
      version: "fixture",
      async embed() {
        return Float32Array.from([1, 0]);
      },
    });
    try {
      if (name === "missing binary") await rm(join(fake.directory, "codex"));
      const old = f.add("old", "Synthetic limit 1");
      const newer = f.add("new", "Synthetic limit 2");
      f.add("duplicate-a", "Synthetic repeated note", "vault");
      f.add("duplicate-b", "Synthetic repeated note", "vault");
      while (await index.processOne()) {
        /* synthetic vector preparation */
      }
      const started = performance.now();
      const run = await runTidy({
        databasePath: f.path,
        areas: ["personal", "vault"],
        embeddingModel: "fixture",
        llm: createCodexLlm(
          fake.env,
          "fixture",
          name === "timeout" ? 200 : 5000,
        ),
      });
      assert.ok(performance.now() - started < 5000);
      assert.equal(run.llm, "unavailable");
      assert.equal(run.llmCalls, 1);
      assert.equal(run.failures, 1);
      assert.equal(run.duplicates, 1);
      assert.equal(run.supersedes, 0);
      assert.equal(run.lastSuccessfulAt, null);
      assert.deepEqual(f.sources.find(old.id, "personal"), old);
      assert.deepEqual(f.sources.find(newer.id, "personal"), newer);
      const history = await readFile(
        join(f.directory, "tidy/history.jsonl"),
        "utf8",
      );
      assert.ok(!history.includes("synthetic-private-diagnostic"));
      assert.ok(!history.includes("Synthetic"));
    } finally {
      await index.close();
      await f.close();
      await fake.close();
    }
  });
}

test("Codex batch output skips invalid, duplicate and missing indexes while applying valid entries", async () => {
  const { createLlm } = await import("../src/llm.js");
  const { fakeCodex } = await import("./fake-codex.js");
  const fake = await fakeCodex(`respond([
    {index:3,area:'personal',confidence:0.95},
    {index:0,area:'personal',confidence:'invalid'},
    {index:1,area:'personal',confidence:0.9},
    {index:1,area:'personal',confidence:0.9},
    {index:999,area:'personal',confidence:1}
  ]);`);
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++)
      f.add(`inbox-${i}`, `Synthetic routing ${i}`, "inbox");
    const llm = createLlm(fake.env);
    assert.ok(llm);
    const run = await runTidy({
      databasePath: f.path,
      areas: ["inbox", "personal"],
      area: "inbox",
      llm,
    });
    assert.equal(run.llmCalls, 1);
    assert.equal(run.failures, 3);
    assert.equal(run.moved, 1);
    assert.ok(f.sources.find("inbox-3", "personal"));
    for (let i = 0; i < 3; i++)
      assert.ok(f.sources.find(`inbox-${i}`, "inbox"));
  } finally {
    await f.close();
    await fake.close();
  }
});

test("invalid entries in a capped window do not starve later pairs or advance success", async () => {
  const f = await fixture();
  const index = new EmbeddingIndex(f.path, {
    version: "fixture",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  let invalid = true;
  try {
    for (let i = 0; i < 21; i++) f.add(`fact-${i}`, `Synthetic limit ${i}`);
    while (await index.processOne()) {
      /* synthetic vector preparation */
    }
    const options = {
      databasePath: f.path,
      areas: ["personal"],
      embeddingModel: "fixture",
      llm: {
        model: "fake",
        async ask(_instruction: string, data: unknown) {
          const result = (data as { index: number }[]).map(({ index }) => ({
            index,
            current: null,
          }));
          if (invalid) {
            result.shift();
            invalid = false;
          }
          return result;
        },
      },
    };
    const first = await runTidy(options);
    assert.equal(first.failures, 1);
    assert.equal(first.pairs, 200);
    const second = await runTidy(options);
    assert.equal(second.pairs, 10);
    assert.equal(second.capped, false);
    assert.equal(second.lastSuccessfulAt, null);
    // A clean replay revisits the skipped entry before the watermark advances.
    assert.equal((await runTidy(options)).pairs, 200);
    assert.ok((await runTidy(options)).lastSuccessfulAt);
  } finally {
    await index.close();
    await f.close();
  }
});
