import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vite-plus/test";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";
import { runTidy } from "../src/tidy.js";

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".output-tidy-"));
  const path = join(directory, "db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const db = new DatabaseSync(path);
  const add = (
    id: string,
    text: string,
    scope = "personal",
    capturedAt = "2026-01-01T00:00:00Z",
  ) => {
    const source = sources.insert({
      id,
      text,
      scope,
      capturedAt,
      origin: "fixture",
    });
    db.prepare("INSERT INTO source_metadata (source_id,type) VALUES (?,?)").run(
      id,
      "note",
    );
    return source;
  };
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
      db.close();
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("tidy preserves a duplicate decision when effective dates reverse on rerun", async () => {
  const f = await fixture();
  try {
    const text =
      "Synthetic lunar garden maintenance records describe watering schedules and seasonal observations.";
    const first = f.capture(text, "2026-01-01T00:00:00Z");
    const second = f.capture(
      text.replace("lunar garden", "lunar  garden"),
      "2026-01-02T00:00:00Z",
    );
    const options = { databasePath: f.path, areas: ["personal"] };
    assert.equal((await runTidy(options)).duplicates, 1);
    const before = f.knowledge.relations("personal");
    const db = new DatabaseSync(f.path);
    try {
      db.prepare(
        "UPDATE source_metadata SET created_at=? WHERE source_id=?",
      ).run("2025-01-01T00:00:00Z", second.id);
    } finally {
      db.close();
    }
    assert.equal((await runTidy({ ...options, dryRun: true })).duplicates, 0);
    assert.equal((await runTidy(options)).duplicates, 0);
    assert.deepEqual(f.knowledge.relations("personal"), before);
    assert.equal(
      f.knowledge.retrievalRelations("personal").canonical(second.id),
      first.id,
    );
  } finally {
    await f.close();
  }
});

test("tidy never closes an existing duplicate chain, including branches into cycles", async (t) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const f = await fixture();
  try {
    const text =
      "Synthetic lunar garden maintenance records describe watering schedules and seasonal observations.";
    f.add("a", text);
    f.add("b", "Different synthetic intermediary");
    f.add("c", text, "personal", "2026-01-03T00:00:00Z");
    for (const [fromId, toId] of [
      ["a", "b"],
      ["b", "c"],
    ] as const) {
      f.knowledge.relate({
        version: 1,
        scope: "personal",
        idempotencyKey: fromId,
        kind: "duplicates",
        fromId,
        toId,
        sourceRefs: [{ sourceId: fromId }],
        creator: { kind: "user", name: "fixture" },
      });
    }
    const before = f.knowledge.relations("personal");
    for (const dryRun of [true, false]) {
      const run = await runTidy({
        databasePath: f.path,
        areas: ["personal"],
        dryRun,
      });
      assert.equal(run.duplicates, 0);
      assert.deepEqual(f.knowledge.relations("personal"), before);
      assert.deepEqual(
        f.sources.search("watering", "personal", 10).map((s) => s.id),
        ["c"],
      );
    }
    vi.setSystemTime(Date.now() + 1000);
    f.add("d", text, "personal", "2026-01-04T00:00:00Z");
    // Legacy cycle a -> b -> c -> a plus a later branch b -> d.
    // d -> a would close another cycle even though canonical(a) is a.
    for (const [fromId, toId] of [
      ["c", "a"],
      ["b", "d"],
    ] as const) {
      f.knowledge.relate({
        version: 1,
        scope: "personal",
        idempotencyKey: `${fromId}:${toId}`,
        kind: "duplicates",
        fromId,
        toId,
        sourceRefs: [{ sourceId: fromId }],
        creator: { kind: "user", name: "fixture" },
      });
    }
    for (const dryRun of [true, false]) {
      const run = await runTidy({
        databasePath: f.path,
        areas: ["personal"],
        dryRun,
      });
      assert.equal(run.duplicates, 0);
      assert.equal(f.knowledge.relations("personal").length, 4);
      assert.deepEqual(
        f.sources
          .search("watering", "personal", 10)
          .map((s) => s.id)
          .sort(),
        ["a", "d"],
      );
    }
  } finally {
    await f.close();
  }
});

test("exact and vector dedup require 80 normalized characters on both sources", async () => {
  for (const text of [
    "fix: deploy",
    "chore: some updates",
    "x".repeat(79),
    "x".repeat(80),
  ]) {
    for (const suffix of ["", "!"]) {
      const f = await fixture();
      const index = new EmbeddingIndex(f.path, {
        version: "fixture",
        async embed() {
          return Float32Array.from([1, 0]);
        },
      });
      try {
        f.add("a", `  ${text}  `);
        f.add("b", `${text}${suffix}`, "personal", "2026-01-02T00:00:00Z");
        while (await index.processOne()) {
          /* synthetic vectors */
        }
        const run = await runTidy({
          databasePath: f.path,
          areas: ["personal"],
          embeddingModel: "fixture",
        });
        assert.equal(
          run.duplicates,
          text.length === 80 ? 1 : 0,
          `${text.length} / ${suffix}`,
        );
        assert.equal(f.knowledge.relations("personal").length, run.duplicates);
      } finally {
        await index.close();
        await f.close();
      }
    }
  }
});

test("tidy without a key deduplicates within areas, preserves originals, and dry-run writes nothing", async () => {
  const f = await fixture();
  try {
    const copy = f.capture(
      "  Synthetic   lunar garden note describing watering schedules with seasonal observations and routine maintenance.  ",
      "2026-01-02T00:00:00Z",
    );
    const original = f.capture(
      "Synthetic lunar garden note describing watering schedules with seasonal observations and routine maintenance.",
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

test("tidy deduplicates with vectors without asking a model to supersede notes", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const f = await fixture();
  const index = new EmbeddingIndex(f.path, {
    version: "fixture",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  try {
    f.add(
      "old",
      "Synthetic lunar garden maintenance instructions specify the maximum simultaneous agents limit 3",
    );
    f.add(
      "new",
      "Synthetic lunar garden maintenance instructions specify the maximum simultaneous agents limit 4",
      "personal",
      "2026-01-02T00:00:00Z",
    );
    f.add(
      "copy",
      "Synthetic lunar garden maintenance instructions specify the maximum simultaneous agents limit 4!",
      "personal",
      "2026-01-03T00:00:00Z",
    );
    f.add(
      "foreign",
      "Synthetic lunar garden maintenance instructions specify the maximum simultaneous agents limit 8",
      "vault",
    );
    while (await index.processOne()) {
      /* synthetic vector preparation */
    }
    let calls = 0;
    const llm = {
      model: "fake",
      async ask(_instruction: string, data: unknown) {
        calls++;
        assert.ok(!JSON.stringify(data).includes("limit 8"));
        return [{ index: 0, current: "a" }];
      },
    };
    const options = {
      databasePath: f.path,
      areas: ["personal"],
      embeddingModel: "fixture",
      llm,
    };
    const run = await runTidy(options);
    assert.equal(run.duplicates, 1);
    assert.equal(run.failures, 0);
    assert.equal(run.outcome, "completed");
    assert.equal(calls, 0);
    assert.deepEqual(
      f.knowledge.relations("personal").map(({ kind, fromId, toId }) => ({
        kind,
        fromId,
        toId,
      })),
      [{ kind: "duplicates", fromId: "copy", toId: "new" }],
    );
    assert.ok(f.sources.find("old", "personal"));
    assert.equal((await runTidy(options)).duplicates, 0);
    assert.equal(calls, 0);
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
    f.add(
      "original",
      "Synthetic dry run note describing lunar garden watering schedules and seasonal observations.",
    );
    f.add(
      "copy",
      "Synthetic dry run note describing lunar garden watering schedules and seasonal observations.",
      "personal",
      "2026-01-02T00:00:00Z",
    );
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
      "Synthetic lunar garden keeps a detailed daily maintenance journal about watering schedules and seasonal observations",
    );
    f.add(
      "below",
      "Synthetic lunar garden keeps a detailed daily maintenance journal about watering schedules and seasonal observations?",
      "personal",
      "2026-01-02T00:00:00Z",
    );
    f.add(
      "above",
      "Synthetic lunar garden keeps a detailed daily maintenance journal about watering schedules and seasonal observations!",
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
  test(`${processor} batches inbox sorting within 12 calls and resumes legacy history`, async () => {
    const { createLlm } = await import("../src/llm.js");
    const { fakeCodex } = await import("./fake-codex.js");
    const fake = await fakeCodex(
      `
assert.ok(Array.isArray(data) && data.length <= 25);
fs.appendFileSync(process.env.HOME + '/calls.jsonl', JSON.stringify(data) + '\\n');
respond(data.map(({index}) => ({index, area:null, confidence:0})));
`,
      `fs.appendFileSync(process.env.HOME + '/preflights', '1'); process.exit(0);`,
    );
    const f = await fixture();
    const apiBatches: unknown[][] = [];
    try {
      f.add("previously-sorted", "Synthetic uncertain inbox note", "inbox");
      await mkdir(join(f.directory, "tidy"));
      await writeFile(
        join(f.directory, "tidy/history.jsonl"),
        `${JSON.stringify({
          areas: ["inbox", "personal"],
          model: "fixture",
          ...(processor === "codex" ? { processor } : {}),
          dryRun: false,
          capped: true,
          inboxAfter: 1,
          lastSuccessfulAt: "2025-01-01T00:00:00Z",
          supersedes: 1,
          pairs: 200,
          pairAfter: { area: "personal", row: 999, priorRow: 998 },
          windowEnd: "2025-01-02T00:00:00Z",
          windowIncomplete: true,
          vectorsMissing: 2,
          failures: 1,
        })}\n`,
      );
      for (let i = 1; i <= 320; i++)
        f.add(`inbox-${i}`, `Synthetic inbox note ${i}`, "inbox");
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
          ) as { index: number }[];
          apiBatches.push(data);
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    data.map(({ index }) => ({
                      index,
                      area: null,
                      confidence: 0,
                    })),
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
        llm,
      };
      const first = await runTidy(options);
      assert.equal(first.processor, processor);
      assert.equal(first.llmCalls, 12);
      assert.equal(first.capped, true);
      assert.equal(first.lastSuccessfulAt, "2025-01-01T00:00:00Z");
      assert.equal(first.uncertain, 300);
      assert.equal(first.failures, 0);
      const second = await runTidy(options);
      assert.equal(second.llmCalls, 1);
      assert.equal(second.uncertain, 20);
      assert.equal(second.capped, false);
      assert.equal(second.lastSuccessfulAt, second.timestamp);
      const batches: unknown[][] =
        processor === "codex"
          ? (await readFile(join(fake.directory, "calls.jsonl"), "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : apiBatches;
      if (processor === "codex")
        assert.equal(
          await readFile(join(fake.directory, "preflights"), "utf8"),
          "11",
        );
      assert.equal(batches.length, 13);
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
      assert.equal(JSON.parse(history.split("\n")[1] ?? "").llmCalls, 12);
    } finally {
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
  ["login timeout", "setInterval(() => {}, 1000);"],
  ["oversized output", "console.log('x'.repeat(256 * 1024));"],
  ["missing binary", ""],
]) {
  test(`Codex ${name} falls back to dedup without exposing diagnostics or changing sources`, async () => {
    const { createCodexLlm } = await import("../src/codex-llm.js");
    const { fakeCodex } = await import("./fake-codex.js");
    const preflightFails = [
      "not logged in",
      "login timeout",
      "missing binary",
    ].includes(name ?? "");
    const fake = await fakeCodex(body ?? "", preflightFails ? body : undefined);
    const f = await fixture();
    try {
      if (name === "missing binary") await rm(join(fake.directory, "codex"));
      const old = f.add("old", "Synthetic limit 1", "inbox");
      const newer = f.add("new", "Synthetic limit 2", "inbox");
      f.add(
        "duplicate-a",
        "Synthetic repeated note describing lunar garden watering schedules and seasonal observations.",
        "vault",
      );
      f.add(
        "duplicate-b",
        "Synthetic repeated note describing lunar garden watering schedules and seasonal observations.",
        "vault",
      );
      const started = performance.now();
      const run = await runTidy({
        databasePath: f.path,
        areas: ["inbox", "personal", "vault"],
        llm: createCodexLlm(
          fake.env,
          "fixture",
          name?.includes("timeout") ? 200 : 5000,
        ),
      });
      assert.ok(performance.now() - started < 5000);
      assert.equal(run.llm, "unavailable");
      assert.equal(run.llmCalls, preflightFails ? 0 : 1);
      assert.equal(run.failures, 1);
      assert.equal(run.duplicates, 1);
      assert.equal(run.lastSuccessfulAt, null);
      assert.deepEqual(f.sources.find(old.id, "inbox"), old);
      assert.deepEqual(f.sources.find(newer.id, "inbox"), newer);
      const history = await readFile(
        join(f.directory, "tidy/history.jsonl"),
        "utf8",
      );
      assert.ok(!history.includes("synthetic-private-diagnostic"));
      assert.ok(!history.includes("Synthetic"));
    } finally {
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

test("invalid inbox entries are retried after capped sorting resumes and wraps", async () => {
  const f = await fixture();
  let invalid = true;
  try {
    for (let i = 0; i < 301; i++)
      f.add(`inbox-${i}`, `Synthetic routing ${i}`, "inbox");
    const options = {
      databasePath: f.path,
      areas: ["inbox", "personal"],
      llm: {
        model: "fake",
        async ask(_instruction: string, data: unknown) {
          const result = (data as { index: number }[]).map(({ index }) => ({
            index,
            area: "personal",
            confidence: 1,
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
    assert.equal(first.moved, 299);
    assert.equal(first.capped, true);
    assert.equal(first.lastSuccessfulAt, null);
    const second = await runTidy(options);
    assert.equal(second.moved, 1);
    assert.equal(second.capped, false);
    assert.ok(f.sources.find("inbox-0", "inbox"));
    const retry = await runTidy(options);
    assert.equal(retry.moved, 1);
    assert.equal(retry.failures, 0);
    assert.ok(f.sources.find("inbox-0", "personal"));
  } finally {
    await f.close();
  }
});
