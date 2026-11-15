import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";

test("reindex usage fails before loading a model", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/scripts/context.js", "reindex"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /embeddings/);
  assert.equal(result.stdout, "");
});

test("reindex is resumable, logged without source text, and never compares mixed models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-reindex-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  let calls = 0;
  let failOnce = true;
  const embedder = {
    version: "synthetic-reindex-v1",
    async embed(text: string) {
      calls++;
      if (failOnce) {
        failOnce = false;
        throw new Error("synthetic embed failed");
      }
      assert.ok(text.length > 0);
      return Float32Array.from([1, 0, 0, 0]);
    },
  };
  const index = new EmbeddingIndex(path, embedder);
  const logs: string[] = [];
  try {
    const first = sources.capture({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "one",
      text: "UNIQUE_SECRET_TEXT alpha",
    }).source;
    const second = sources.capture({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "two",
      text: "UNIQUE_SECRET_TEXT beta",
    }).source;
    knowledge.add({
      version: 1,
      scope: "personal",
      kind: "observation",
      text: "UNIQUE_SECRET_TEXT gamma",
      sourceRefs: [{ sourceId: first.id }],
      creator: { kind: "user", name: "fixture" },
      idempotencyKey: "gamma",
    });
    const sourceIds = [first.id, second.id];
    await index.reindexEmbeddings(1, (status) => {
      logs.push(JSON.stringify(status));
    });
    const done = index.status("personal");
    assert.equal(done.failed, 0);
    assert.equal(done.queued, 0);
    assert.equal(done.completed, 3);
    assert.ok(done.chunks >= 3);
    assert.equal(logs.join("\n").includes("UNIQUE_SECRET_TEXT"), false);
    const after = calls;
    await index.reindexEmbeddings(8, () => {});
    assert.equal(calls, after);

    const kept = sourceIds[0];
    const other = sourceIds[1];
    assert.ok(kept && other);
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE embedding_chunks SET model = ? WHERE kind = 'sources' AND record_id = ?",
    ).run("synthetic-reindex-v2", kept);
    db.close();
    const mixed = new EmbeddingIndex(path, {
      version: "synthetic-reindex-v2",
      async embed() {
        return Float32Array.from([1, 0, 0, 0]);
      },
    });
    try {
      const hits = await mixed.search({
        scope: "personal",
        question: "alpha",
      });
      assert.equal(hits.available, true);
      assert.ok(hits.reasons.includes("embeddings_mixed"));
      assert.deepEqual(
        hits.sources.map((hit) => hit.id),
        [kept],
      );
      assert.equal(
        hits.sources.some((hit) => hit.id === other),
        false,
      );
      assert.deepEqual(mixed.status().otherModels, ["synthetic-reindex-v1"]);
    } finally {
      await mixed.close();
    }
  } finally {
    await index.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
