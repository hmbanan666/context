// Explicit offline measurement only; never part of the model-free test suite.
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildContextPackage } from "../src/context-package.js";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { localEmbedder, textChunks } from "../src/embedding-model.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";

const directory = await mkdtemp(resolve(".output/search-benchmark-"));
const path = join(directory, "db");
const sources = new SourceStore(path),
  knowledge = new KnowledgeStore(path);
const model = localEmbedder(process.argv[2] ?? ".output/models");
const index = new EmbeddingIndex(path, model);
const rss = () => Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
const stats = (values: number[]) => ({
  meanMs: values.reduce((a, b) => a + b, 0) / values.length,
  p95Ms: [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
});
try {
  globalThis.fetch = async () => {
    throw new Error("Runtime network is forbidden in this benchmark");
  };
  const before = rss(),
    start = performance.now();
  await model.load?.();
  const loadMs = performance.now() - start,
    loaded = rss();
  const passage =
    "The fictional observatory keeps safety copies nightly. Наблюдатели делают резервные копии журналов, чтобы восстановить данные после потери диска.";
  const measurements: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await model.embed(passage, "passage");
    measurements.push(performance.now() - start);
  }
  const long = passage.repeat(20);
  const longStart = performance.now();
  for (const chunk of textChunks(long))
    await model.embed(chunk.text, "passage");
  const longMs = performance.now() - longStart;
  for (let i = 0; i < 100; i++)
    sources.capture({
      version: 1,
      scope: "synthetic",
      text: passage,
      origin: "fixture",
      idempotencyKey: `sample-${i}`,
    });
  const fill = performance.now();
  while (await index.processOne()) {
    /* real embeddings */
  }
  const backfillMs = performance.now() - fill;
  const queryTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const request = {
      scope: "synthetic",
      question:
        i % 2
          ? "Как восстановить потерянные наблюдения?"
          : "How can I restore lost observations?",
    };
    const hits = await index.search(request);
    const result = buildContextPackage(sources, knowledge, request, hits);
    if (
      !result.sources.length ||
      hits.reasons.includes("embeddings_unavailable")
    )
      throw new Error("Benchmark retrieval failed");
    queryTimes.push(performance.now() - start);
  }
  // Scale the scan with repeated synthetic chunks, not 50k real model calls.
  // This measures vector/SQLite/ranking cost separately from backfill throughput.
  const db = new DatabaseSync(path);
  db.exec(`BEGIN; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<499)
    INSERT INTO embedding_chunks(kind,record_id,scope,chunk,offset,model,vector)
    SELECT c.kind,c.record_id,c.scope,n.x,c.offset,c.model,c.vector FROM embedding_chunks c CROSS JOIN n WHERE c.chunk=0; COMMIT`);
  db.close();
  const scaleTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await index.search({
      scope: "synthetic",
      question: "restore lost observations",
    });
    scaleTimes.push(performance.now() - start);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        threads: 2,
        beforeMiB: before,
        loadMs,
        loadedMiB: loaded,
        passageCharacters: passage.length,
        embed: stats(measurements),
        longItem: {
          characters: long.length,
          chunks: textChunks(long).length,
          totalMs: longMs,
        },
        backfill100ItemsMs: backfillMs,
        hybrid100Items: stats(queryTimes),
        scan50000Chunks: stats(scaleTimes),
        finalMiB: rss(),
        peakMiB: process.resourceUsage().maxRSS / 1024,
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
