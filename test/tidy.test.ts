import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
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
    const original = f.add("original", "Synthetic lunar garden note");
    const copy = f.add(
      "copy",
      "  Synthetic   lunar garden note  ",
      "personal",
      "2026-01-02T00:00:00Z",
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
        return invalid ? { supersedes: "yes" } : { supersedes: true };
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
        const d = data as { text: string; areas: string[] };
        assert.ok(!d.areas.includes("vault"));
        return {
          area: "personal",
          confidence: d.text.includes("confident") ? 0.95 : 0.6,
        };
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
        async ask() {
          calls++;
          return { supersedes: false };
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
    assert.equal(calls, 210);
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
