import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { retrieveForEval } from "../src/eval-retrieval.js";
import { openPackageFixture } from "./fixtures/package-client.js";

test("eval retrieves the same vector-only evidence as protected MCP", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  const path = join(dir, "db");
  const f = await openPackageFixture(path, {
    version: "synthetic-eval-v1",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "copies",
      text: "The observatory keeps safety copies nightly.",
    }).source;
    f.store.capture({
      version: 1,
      scope: "forbidden",
      origin: "fixture",
      idempotencyKey: "hidden",
      text: "Confidential synthetic passage.",
    });
    assert.ok(f.embeddings instanceof EmbeddingIndex);
    while (await f.embeddings.processOne()) {
      /* drain fake embeddings */
    }
    const question = {
      id: "cross_language",
      question: "Как восстановить наблюдения?",
      areas: ["personal"],
      read_areas: ["personal"],
      forbidden_areas: ["forbidden"],
      expected: [{ source_id: source.id }],
      tags: [],
      placeholder: false,
    };
    const client = await f.connect();
    const response = await client.callTool({
      name: "context_package",
      arguments: { question: question.question },
    });
    assert.equal(
      (response.structuredContent as { sources: { id: string }[] }).sources[0]
        ?.id,
      source.id,
    );
    assert.equal((await retrieveForEval(path, question, 10)).hits.length, 0);
    const retrieved = await retrieveForEval(path, question, 10, f.embeddings);
    assert.deepEqual(
      retrieved.hits.map((h: { id: string }) => h.id),
      [source.id],
    );
    assert.equal(retrieved.isolationViolations, 0);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval records hybrid mode and vector-only questions without taking ownership of the shared model", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { evaluate } = await import("../src/eval-runner.js");
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  const path = join(dir, "db");
  let closed = 0;
  let failQuery = false;
  const f = await openPackageFixture(path, {
    version: "synthetic-eval-v1",
    async embed(text, purpose) {
      if (failQuery && purpose === "query" && text === "safety copies")
        throw new Error("Synthetic query failure");
      return Float32Array.from([1, 0]);
    },
    async close() {
      closed++;
    },
  });
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "copies",
      text: "The observatory keeps safety copies nightly.",
    }).source;
    assert.ok(f.embeddings);
    while (await f.embeddings.processOne()) {
      /* drain */
    }
    const questionsPath = join(dir, "questions.json");
    await writeFile(
      questionsPath,
      JSON.stringify({
        questions: ["Как восстановить наблюдения?", "safety copies"].map(
          (question, i) => ({
            id: `q${i}`,
            question,
            areas: ["personal"],
            read_areas: ["personal"],
            expected: [{ source_id: source.id }],
          }),
        ),
      }),
    );
    const before = await readFile(path);
    const options = {
      databasePath: path,
      questionsPath,
      directory: dir,
      areas: ["personal"],
      k: 10,
    };
    const run = await evaluate(options, f.embeddings);
    assert.equal(run.metrics.hit_at_k, 1);
    assert.deepEqual(run.search, {
      mode: "hybrid",
      model: "synthetic-eval-v1",
      semantic: "available",
    });
    assert.deepEqual(run.diagnostics, {
      compared_questions: 2,
      vector_only_questions: 1,
      lexical_only_questions: 0,
    });
    failQuery = true;
    const partial = await evaluate(options, f.embeddings);
    assert.equal(partial.search.mode, "hybrid");
    assert.equal(partial.search.semantic, "partial");
    assert.equal(partial.metrics.hit_at_k, 1);
    assert.equal(closed, 0);
    assert.deepEqual(await readFile(path), before);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone eval opens vectors read-only and reports model failure in output and history", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { evaluateWithLocalModel } = await import("../src/eval-search.js");
  const { appendEvalRun, evalHistory } = await import("../src/eval-history.js");
  const { formatRun } = await import("../src/eval-cli.js");
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  const path = join(dir, "db");
  let available = true,
    loads = 0,
    closes = 0;
  const embedder = {
    version: "synthetic-eval-v1",
    async load() {
      loads++;
      if (!available) throw new Error("private failure");
    },
    async embed() {
      if (!available) throw new Error("private failure");
      return Float32Array.from([1, 0]);
    },
    async close() {
      closes++;
    },
  };
  const f = await openPackageFixture(path, embedder);
  const source = f.store.capture({
    version: 1,
    scope: "personal",
    origin: "fixture",
    idempotencyKey: "copies",
    text: "The observatory keeps safety copies nightly.",
  }).source;
  assert.ok(f.embeddings);
  while (await f.embeddings.processOne()) {
    /* drain */
  }
  await f.close();
  try {
    const before = await readFile(path);
    const readonly = new EmbeddingIndex(path, embedder, { readOnly: true });
    assert.throws(() => readonly.backfill());
    assert.throws(() => readonly.rebuild());
    await assert.rejects(readonly.processOne());
    await readonly.close();
    const questionsPath = join(dir, "questions.json");
    await writeFile(
      questionsPath,
      JSON.stringify({
        questions: [
          {
            id: "q1",
            question: "Как восстановить наблюдения?",
            areas: ["personal"],
            read_areas: ["personal"],
            expected: [{ source_id: source.id }],
          },
        ],
      }),
    );
    const options = {
      databasePath: path,
      questionsPath,
      directory: dir,
      areas: ["personal"],
      k: 10,
    };
    let run = await evaluateWithLocalModel(options, embedder);
    assert.equal(run.metrics.hit_at_k, 1);
    assert.equal(run.search.mode, "hybrid");
    assert.equal(loads, 1);
    assert.equal(closes, 3);
    await appendEvalRun(dir, run);
    available = false;
    run = await evaluateWithLocalModel(options, embedder);
    assert.equal(run.metrics.hit_at_k, 0);
    assert.deepEqual(run.search, {
      mode: "lexical",
      model: embedder.version,
      semantic: "unavailable",
    });
    assert.match(formatRun(run), /semantic: unavailable/);
    assert.ok(!JSON.stringify(run).includes("private failure"));
    await appendEvalRun(dir, run);
    const history = await evalHistory(dir);
    assert.equal(history[0]?.search.semantic, "unavailable");
    assert.equal(history[1]?.search.mode, "hybrid");
    assert.deepEqual(await readFile(path), before);
    await writeFile(
      join(dir, "history.jsonl"),
      `${JSON.stringify({ ...run, schema_version: 1, search: undefined, diagnostics: undefined })}\n${JSON.stringify(run)}\n`,
    );
    const mixed = await evalHistory(dir);
    assert.equal(mixed[0]?.delta_previous, null);
    assert.ok(mixed[1]);
    assert.match(formatRun(mixed[1]), /unrecorded \(legacy row\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("semantic candidates use a 0.80 floor, top 20 cap and outweigh duplicate lexical evidence", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  const path = join(dir, "db");
  const f = await openPackageFixture(path, {
    version: "synthetic-eval-v1",
    async embed(text, purpose) {
      const score = text.includes("vault")
        ? 0.8
        : text.includes("copies")
          ? 0.9
          : 0.795;
      return Float32Array.from(
        purpose === "query" ? [1, 0] : [score, Math.sqrt(1 - score ** 2)],
      );
    },
  });
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "copies",
      text: "The observatory keeps safety copies nightly.",
    }).source;
    for (let i = 0; i < 15; i++)
      f.store.capture({
        version: 1,
        scope: "personal",
        origin: "fixture",
        idempotencyKey: `noise-${i}`,
        text: `Fictional unrelated passage ${i}.`,
      });
    assert.ok(f.embeddings);
    while (await f.embeddings.processOne()) {
      /* drain */
    }
    const client = await f.connect();
    const r = await client.callTool({
      name: "context_package",
      arguments: { question: "Как восстановить наблюдения?" },
    });
    assert.deepEqual(
      (r.structuredContent as { sources: { id: string }[] }).sources.map(
        (s) => s.id,
      ),
      [source.id],
    );
    for (let i = 0; i < 25; i++)
      f.store.capture({
        version: 1,
        scope: "personal",
        origin: "fixture",
        idempotencyKey: `strong-${i}`,
        text: `Safety copies are stored in fictional vault ${i}.`,
      });
    while (await f.embeddings.processOne()) {
      /* drain */
    }
    const capped = await client.callTool({
      name: "context_package",
      arguments: { question: "Как восстановить наблюдения?", limit: 20 },
    });
    assert.equal(
      (capped.structuredContent as { sources: unknown[] }).sources.length,
      20,
    );
    const fused = await client.callTool({
      name: "context_package",
      arguments: { question: "unrelated", limit: 1 },
    });
    assert.deepEqual(
      (fused.structuredContent as { sources: { id: string }[] }).sources.map(
        (s) => s.id,
      ),
      [source.id],
    );
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
