import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";

// All corpus and question text in this file is fictional.
test("eval CLI measures synthetic retrieval, keeps content out of history, and leaves the corpus unchanged", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const path = join(dir, "context.db");
    const sources = new SourceStore(path);
    sources.captureMaterial({
      version: 1,
      scope: "garden",
      origin: "synthetic",
      idempotencyKey: "iris",
      text: "The cobalt iris needs shade.",
      metadata: { sourceUri: "https://fictional.example/iris" },
    });
    sources.capture({
      version: 1,
      scope: "vault",
      origin: "synthetic",
      idempotencyKey: "hidden",
      text: "The cobalt iris secret is violet.",
    });
    new KnowledgeStore(path).close();
    sources.close();
    const before = await readFile(path);
    await mkdir(join(dir, "evals"));
    const questions = join(dir, "evals", "questions.yaml");
    await writeFile(
      questions,
      `questions:
  - id: q01
    question: What does the cobalt iris need?
    areas: [garden]
    read_areas: [garden]
    forbidden_areas: [vault]
    expected:
      - source_external_id: https://fictional.example/iris
      - substring: needs shade
      - substring: absent outcome
  - id: q02
    question: missing
    areas: [garden]
    read_areas: [garden]
    expected:
      - substring: absent placeholder evidence
    placeholder: true
`,
    );
    const env = {
      ...process.env,
      CONTEXT_DB_PATH: path,
      CONTEXT_AREAS: "garden,vault",
    };
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["dist/scripts/context.js", "eval", ...args],
        { env, encoding: "utf8" },
      );
    const result = run("run", "--json");
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.search.mode, "lexical");
    assert.equal(summary.search.semantic, "unavailable");
    assert.equal(summary.metrics.hit_at_1, 1);
    assert.equal(summary.metrics.hit_at_k, 1);
    assert.equal(summary.metrics.mrr, 1);
    assert.equal(summary.metrics.isolation_violations, 0);
    assert.equal(summary.diagnostics.compared_questions, 1);
    assert.deepEqual(summary.diagnostics.lexical, {
      hit_at_1: 1,
      hit_at_k: 1,
      mrr: 1,
    });
    assert.equal(summary.questions[0].pass, true);
    assert.equal(summary.questions[1].status, "skipped");
    assert.ok(summary.question_file_hash);
    assert.equal(run("run", "--json").status, 0);
    const history = run("history", "--json");
    assert.equal(history.status, 0, history.stderr);
    const rows = JSON.parse(history.stdout);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].delta_previous.hit_at_k, 0);
    assert.equal(rows[0].delta_previous.mrr, 0);
    assert.deepEqual(rows[0].diagnostics.lexical, summary.diagnostics.lexical);
    for (const privateText of [
      "cobalt",
      "needs shade",
      "fictional.example",
      "garden",
      "vault",
    ]) {
      assert.ok(!result.stdout.includes(privateText));
      assert.ok(!history.stdout.includes(privateText));
    }
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval detects forbidden results, rejects invalid files safely, and bounds options", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const path = join(dir, "context.db");
    const sources = new SourceStore(path);
    const source = sources.capture({
      version: 1,
      scope: "garden",
      origin: "synthetic",
      idempotencyKey: "private",
      text: "Fictional marigold grows.",
    }).source;
    new KnowledgeStore(path).close();
    sources.close();
    await mkdir(join(dir, "evals"));
    const questions = join(dir, "evals", "questions.yaml");
    const env = {
      ...process.env,
      CONTEXT_DB_PATH: path,
      CONTEXT_AREAS: "garden,vault",
    };
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["dist/scripts/context.js", "eval", ...args],
        { env, encoding: "utf8" },
      );
    const q = {
      id: "isolation01",
      question: "marigold",
      areas: ["garden"],
      read_areas: ["garden"],
      forbidden_areas: ["garden"],
      expected: [{ source_id: source.id }],
    };
    await writeFile(questions, JSON.stringify({ questions: [q] }));
    const result = run("run", "--json");
    assert.equal(result.status, 2, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.metrics.isolation_violations, 1);
    assert.equal(summary.questions[0].pass, false);
    assert.equal(summary.metrics.hit_at_k, 1);
    // Searching an ungranted area must exercise denial, not grant it implicitly.
    await writeFile(
      questions,
      JSON.stringify({ questions: [{ ...q, read_areas: [], expected: [] }] }),
    );
    const denied = run("run", "--json");
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).metrics.isolation_violations, 0);
    assert.equal(JSON.parse(denied.stdout).metrics.hit_at_k, null);
    assert.equal(JSON.parse(denied.stdout).questions[0].pass, true);
    assert.equal(JSON.parse(denied.stdout).diagnostics.compared_questions, 0);
    assert.deepEqual(JSON.parse(denied.stdout).diagnostics.lexical, {
      hit_at_1: null,
      hit_at_k: null,
      mrr: null,
    });
    for (const content of [
      "private: [malformed",
      "questions: &data [*data]",
      JSON.stringify({ questions: [q, q] }),
      JSON.stringify({ questions: [{ ...q, areas: ["unknown"] }] }),
    ]) {
      await writeFile(questions, content);
      const failed = run("run", "--json");
      assert.equal(failed.status, 1);
      assert.equal(JSON.parse(failed.stdout).outcome, "failed");
      assert.ok(!`${failed.stdout}${failed.stderr}`.includes("private"));
    }
    assert.equal(run("run", "--k", "21").status, 1);
    assert.equal(run("run", "--k", "0").status, 1);
    assert.equal(run("run", "--baseline").status, 1);
    assert.equal(run("run", "--json", "--json").status, 1);
    assert.equal(JSON.parse(run("history", "--json").stdout).length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only eval stores refuse writes and do not create a missing corpus", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const path = join(dir, "context.db");
    assert.throws(() => new SourceStore(path, { readOnly: true }));
    new SourceStore(path).close();
    new KnowledgeStore(path).close();
    const sources = new SourceStore(path, { readOnly: true });
    try {
      assert.throws(() =>
        sources.capture({
          version: 1,
          scope: "garden",
          origin: "synthetic",
          idempotencyKey: "attempt",
          text: "Fictional orchid",
        }),
      );
    } finally {
      sources.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval preserves multi-area rank, computes reciprocal rank, and compares only matching question sets and k", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const path = join(dir, "context.db");
    const sources = new SourceStore(path);
    sources.capture({
      version: 1,
      scope: "orchard",
      origin: "synthetic",
      idempotencyKey: "first",
      text: "The fictional cobalt apple is sweet.",
    });
    const expected = sources.capture({
      version: 1,
      scope: "garden",
      origin: "synthetic",
      idempotencyKey: "second",
      text: "The fictional cobalt iris needs shade.",
    }).source.id;
    new KnowledgeStore(path).close();
    sources.close();
    const questions = join(dir, "questions.json");
    await writeFile(
      questions,
      JSON.stringify({
        questions: [
          {
            id: "rank02",
            question: "cobalt",
            areas: ["orchard", "garden"],
            read_areas: ["orchard", "garden"],
            expected: [
              { substring: "absent acceptable evidence" },
              { source_id: expected },
            ],
          },
        ],
      }),
    );
    const env = {
      ...process.env,
      CONTEXT_DB_PATH: path,
      CONTEXT_AREAS: "orchard,garden",
    };
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ["dist/scripts/context.js", "eval", ...args],
        { env, encoding: "utf8" },
      );
    const result = run("run", "--questions", questions, "--k", "2", "--json");
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.metrics.hit_at_1, 0);
    assert.equal(summary.metrics.hit_at_k, 1);
    assert.equal(summary.metrics.mrr, 0.5);
    assert.deepEqual(summary.diagnostics.lexical, {
      hit_at_1: 0,
      hit_at_k: 1,
      mrr: 0.5,
    });
    assert.equal(summary.questions[0].pass, true);
    assert.ok(summary.metrics.latency_p50_ms > 0);
    assert.equal(
      summary.metrics.latency_p50_ms,
      summary.metrics.latency_p95_ms,
    );
    const capped = run("run", "--questions", questions, "--k", "1", "--json");
    assert.equal(capped.status, 0);
    assert.equal(JSON.parse(capped.stdout).metrics.hit_at_k, 0);
    assert.equal(JSON.parse(capped.stdout).metrics.mrr, 0);
    assert.equal(JSON.parse(capped.stdout).questions[0].pass, false);
    const history = JSON.parse(run("history", "--json", "--limit", "1").stdout);
    assert.equal(history.length, 1);
    assert.equal(history[0].delta_previous, null);
    assert.equal(history[0].previous_id, summary.id);
    await writeFile(
      questions,
      JSON.stringify({
        questions: [
          {
            id: "changed",
            question: "cobalt",
            areas: ["garden"],
            read_areas: ["garden"],
            expected: [{ source_id: expected }],
          },
        ],
      }),
    );
    assert.equal(
      run("run", "--questions", questions, "--k", "1", "--json").status,
      0,
    );
    assert.equal(
      JSON.parse(run("history", "--json").stdout)[0].delta_previous,
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval matches a returned knowledge excerpt with its grounded source rank", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const path = join(dir, "context.db");
    const sources = new SourceStore(path);
    const source = sources.capture({
      version: 1,
      scope: "garden",
      origin: "synthetic",
      idempotencyKey: "grounding",
      text: "Fictional cobalt iris.",
    }).source;
    const knowledge = new KnowledgeStore(path);
    knowledge.add({
      version: 1,
      scope: "garden",
      idempotencyKey: "derived",
      kind: "observation",
      text: "The fictional orchid arrangement is triangular.",
      sourceRefs: [{ sourceId: source.id }],
      creator: { kind: "model", name: "synthetic" },
    });
    knowledge.close();
    sources.close();
    const questions = join(dir, "questions.json");
    await writeFile(
      questions,
      JSON.stringify({
        questions: [
          {
            id: "derived01",
            question: "orchid",
            areas: ["garden"],
            read_areas: ["garden"],
            expected: [{ substring: "arrangement is triangular" }],
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/context.js",
        "eval",
        "run",
        "--questions",
        questions,
        "--json",
      ],
      {
        env: { ...process.env, CONTEXT_DB_PATH: path, CONTEXT_AREAS: "garden" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).metrics.hit_at_k, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import and eval CLI coexist and match imported external IDs and URLs", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const path = join(dir, "context.db");
    new SourceStore(path).close();
    new KnowledgeStore(path).close();
    const env = {
      ...process.env,
      CONTEXT_DB_PATH: path,
      CONTEXT_AREAS: "garden",
    };
    const imported = spawnSync(
      process.execPath,
      [
        "dist/scripts/context.js",
        "import",
        "jsonl",
        "--source",
        "synthetic",
        "--area",
        "garden",
      ],
      {
        env,
        encoding: "utf8",
        input: `${JSON.stringify({ id: "fictional-iris-01", text: "The fictional cobalt iris needs shade.", url: "https://fictional.example/iris" })}\n`,
      },
    );
    assert.equal(imported.status, 0, imported.stderr);
    const questions = join(dir, "questions.json");
    await writeFile(
      questions,
      JSON.stringify({
        questions: [
          {
            id: "imported01",
            question: "cobalt iris",
            areas: ["garden"],
            read_areas: ["garden"],
            expected: [
              { source_external_id: "fictional-iris-01" },
              { source_external_id: "https://fictional.example/iris" },
            ],
          },
        ],
      }),
    );
    const evaluated = spawnSync(
      process.execPath,
      [
        "dist/scripts/context.js",
        "eval",
        "run",
        "--questions",
        questions,
        "--json",
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(evaluated.status, 0, evaluated.stderr);
    const summary = JSON.parse(evaluated.stdout);
    assert.equal(summary.metrics.hit_at_k, 1);
    assert.equal(summary.metrics.isolation_violations, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
