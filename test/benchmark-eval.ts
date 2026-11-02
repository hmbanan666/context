// Explicit offline calibration and CLI resource measurement, never run by tests.
// Prepare the pinned model at ./models using download-search-model first.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  crossLanguagePairs,
  unrelatedQuestions,
} from "../fixtures/evals/cross-language.js";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { localEmbedder } from "../src/embedding-model.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";

await mkdir(".output", { recursive: true });
const directory = await mkdtemp(".output/eval-benchmark-");
const path = join(directory, "db");
const sources = new SourceStore(path);
const knowledge = new KnowledgeStore(path);
const model = localEmbedder();
const index = new EmbeddingIndex(path, model);
try {
  globalThis.fetch = async () => {
    throw new Error("Runtime network forbidden");
  };
  await model.load?.();
  const passages = [];
  for (const [, text] of crossLanguagePairs)
    passages.push(await model.embed(text, "passage"));
  const rows: {
    expected: number | null;
    scores: { id: number; score: number }[];
  }[] = [];
  for (const [i, question] of [
    ...crossLanguagePairs.map((p) => p[0]),
    ...unrelatedQuestions,
  ].entries()) {
    const query = await model.embed(question, "query");
    const scores = passages
      .map((v, id) => ({
        id,
        score: v.reduce((sum, value, j) => sum + value * (query[j] ?? 0), 0),
      }))
      .sort((a, b) => b.score - a.score);
    rows.push({ expected: i < passages.length ? i : null, scores });
  }
  const rules = [
    { floor: 0.8, gap: 1, cap: 101 },
    { floor: 0.76, gap: 0.02, cap: 10 },
    { floor: 0.78, gap: 0.01, cap: 10 },
  ].map((rule) => {
    let relevant = 0,
      irrelevant = 0,
      absentWithHits = 0;
    for (const row of rows) {
      const best = row.scores[0]?.score ?? 1;
      const hits = row.scores
        .filter((s) => s.score >= rule.floor && s.score >= best - rule.gap)
        .slice(0, rule.cap);
      relevant += hits.filter((s) => s.id === row.expected).length;
      irrelevant += hits.filter((s) => s.id !== row.expected).length;
      absentWithHits += Number(row.expected === null && hits.length > 0);
    }
    return { ...rule, relevant, irrelevant, absentWithHits };
  });
  const questions = [];
  for (const [i, [question, text]] of crossLanguagePairs.entries()) {
    const source = sources.capture({
      version: 1,
      scope: "synthetic",
      origin: "fixture:calibration",
      idempotencyKey: `pair-${i}`,
      text,
    }).source;
    questions.push({
      id: `q${i}`,
      question,
      areas: ["synthetic"],
      read_areas: ["synthetic"],
      expected: [{ source_id: source.id }],
    });
  }
  while (await index.processOne()) {
    /* real model, synthetic sources only */
  }
  // Repeat stored synthetic vectors to measure the scan at the reported scale,
  // not the relevance of a 14,550-passage corpus. No production data is used.
  const db = new DatabaseSync(path);
  db.exec("BEGIN");
  const originals = db
    .prepare("SELECT * FROM embedding_chunks WHERE chunk=0 ORDER BY record_id")
    .all();
  const repeat = db.prepare(
    "INSERT INTO embedding_chunks(kind,record_id,scope,chunk,offset,model,vector) VALUES(?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 14550 - originals.length; i++) {
    const row = originals[i % originals.length];
    if (!row) throw new Error("Missing synthetic vector");
    repeat.run(
      String(row.kind),
      String(row.record_id),
      String(row.scope),
      Math.floor(i / originals.length) + 1,
      Number(row.offset),
      String(row.model),
      row.vector as Uint8Array,
    );
  }
  db.exec("COMMIT");
  db.close();
  const questionsPath = join(directory, "questions.json");
  await writeFile(questionsPath, JSON.stringify({ questions }));
  const rssFile = join(directory, "rss.txt");
  const probePath = join(directory, "rss.mjs");
  await writeFile(
    probePath,
    `import { writeFileSync } from "node:fs";
    globalThis.fetch = async () => { throw new Error("Runtime network forbidden"); };
    process.on("exit", () => writeFileSync(${JSON.stringify(resolve(rssFile))}, String(process.resourceUsage().maxRSS)));`,
  );
  // Kernel high-water RSS of the actual CLI, including startup/model load.
  const parentMiB = process.memoryUsage().rss / 1048576;
  let stdout = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve(probePath)).href,
      "dist/scripts/context.js",
      "eval",
      "run",
      "--questions",
      questionsPath,
      "--json",
    ],
    {
      env: {
        ...process.env,
        CONTEXT_DB_PATH: path,
        CONTEXT_AREAS: "synthetic",
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("CLI benchmark failed")),
    );
  });
  const run = JSON.parse(stdout);
  console.log(
    JSON.stringify(
      {
        model: model.version,
        node: process.version,
        pairs: passages.length,
        unrelatedQueries: unrelatedQuestions.length,
        expectedCosines: rows.flatMap((row) =>
          row.expected === null
            ? []
            : [row.scores.find((s) => s.id === row.expected)?.score],
        ),
        unrelatedBestCosines: rows
          .filter((row) => row.expected === null)
          .map((row) => row.scores[0]?.score),
        rules,
        indexedChunks: index.status().chunks,
        parentWithModelMiB: parentMiB,
        cliPeakMiB: Number((await readFile(rssFile, "utf8")).trim()) / 1024,
        search: run.search,
        diagnostics: run.diagnostics,
        metrics: run.metrics,
      },
      null,
      2,
    ),
  );
} finally {
  await index.close();
  knowledge.close();
  sources.close();
  await rm(directory, { recursive: true, force: true });
}
