import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  buildContextPackage,
  searchGroundingReport,
} from "../src/context-package.js";
import { EmbeddingIndex } from "../src/embedding-index.js";
import {
  defaultGroundingThresholds,
  explainStoredGrounding,
  type GroundingVector,
} from "../src/grounding.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { registerSearchFunctions } from "../src/search-lexical.js";
import { emptyPhases } from "../src/search-timing.js";
import { SourceStore } from "../src/store.js";

const model = "synthetic-speed-v1";
const scope = "personal";

function blob(values: readonly number[]): Buffer {
  const vector = Float32Array.from(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

// The previous lookup put scope and model in WHERE. SQLite then used
// embedding_chunks_area and scanned the area once per candidate. This is that
// query, kept as the reference for which rows and scores grounding may see.
function legacyStoredCosines(
  db: DatabaseSync,
  query: ArrayLike<number>,
  records: readonly { kind: string; id: string }[],
): { id: string; offset: number; score: number }[] {
  const statement = db.prepare(
    "SELECT offset, vector FROM embedding_chunks WHERE kind=? AND record_id=? AND scope=? AND model=?",
  );
  const hits: { id: string; offset: number; score: number }[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== "sources" && record.kind !== "knowledge_items")
      continue;
    if (!record.id || record.id.length > 128) continue;
    const key = `${record.kind}\0${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = statement.all(record.kind, record.id, scope, model);
    for (const row of rows) {
      if (
        !(row.vector instanceof Uint8Array) ||
        row.vector.byteLength !== query.length * 4 ||
        typeof row.offset !== "number"
      )
        continue;
      const bytes = Buffer.from(row.vector);
      let score = 0;
      for (let i = 0; i < query.length; i++)
        score += (query[i] ?? 0) * bytes.readFloatLE(i * 4);
      if (!Number.isFinite(score)) continue;
      hits.push({ id: record.id, offset: row.offset, score });
    }
  }
  return hits;
}

function scored(
  hits: readonly { id: string; offset: number; score?: number }[],
): { id: string; offset: number; score: number }[] {
  return hits.flatMap((hit) =>
    typeof hit.score === "number"
      ? [{ id: hit.id, offset: hit.offset, score: hit.score }]
      : [],
  );
}

function bestScores(
  hits: readonly { id: string; offset: number; score: number }[],
): [string, number][] {
  const best = new Map<string, number>();
  for (const hit of hits) {
    const key = `${hit.id}\0${hit.offset}`;
    const prior = best.get(key);
    if (prior === undefined || hit.score > prior) best.set(key, hit.score);
  }
  return [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function vectorsFor(
  hits: readonly { id: string; offset: number; score: number }[],
  id: string,
): GroundingVector[] {
  return hits
    .filter((hit) => hit.id === id)
    .map((hit) => ({ offset: hit.offset, score: hit.score }));
}

test("fast chunk lookup keeps the same grounding label and scores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grounding-equiv-"));
  const path = join(dir, "db");
  const store = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const query = Float32Array.from([1, 0]);
  const index = new EmbeddingIndex(path, {
    version: model,
    async embed() {
      return Float32Array.from(query);
    },
  });
  try {
    const lantern = store.capture({
      version: 1,
      scope,
      text: "The cobalt lantern is in the blue cabinet.",
      origin: "fixture",
      idempotencyKey: "lantern",
    }).source;
    for (let i = 0; i < 7; i++)
      store.capture({
        version: 1,
        scope,
        text: `Ordinary filler note ${i} about the desk.`,
        origin: "fixture",
        idempotencyKey: `filler-${i}`,
      });
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      "INSERT INTO embedding_chunks (kind, record_id, scope, chunk, offset, model, vector) VALUES ('sources', ?, ?, ?, 0, ?, ?)",
    );
    // Below the 0.80 retrieval floor, so only the stored-cosine lookup can
    // supply it. A wrong scope or model at the same offset would raise it to 1.
    insert.run(lantern.id, scope, 0, model, blob([0.5, 0]));
    insert.run(lantern.id, scope, 1, "other-model", blob([1, 0]));
    insert.run(lantern.id, "other-area", 2, model, blob([1, 0]));
    const fillers = db
      .prepare("SELECT id FROM sources WHERE id <> ?")
      .all(lantern.id);
    for (const row of fillers)
      insert.run(String(row.id), scope, 0, model, blob([0, 1]));
    db.close();

    const semantic = await index.search({
      scope,
      question: "where is the lantern",
    });
    const records = [
      { kind: "sources" as const, id: lantern.id },
      { kind: "sources" as const, id: lantern.id },
      { kind: "sources" as const, id: "" },
      { kind: "sources" as const, id: "x".repeat(129) },
      { kind: "nope" as "sources", id: lantern.id },
    ];
    const produced = semantic.storedCosines?.(records) ?? [];
    const reader = new DatabaseSync(path, { readOnly: true });
    const legacy = legacyStoredCosines(reader, query, records);
    reader.close();
    assert.deepEqual(bestScores(scored(produced)), bestScores(legacy));
    assert.deepEqual(bestScores(scored(produced)), [
      [`${lantern.id}\0${0}`, 0.5],
    ]);

    const passage = "The cobalt lantern is in the blue cabinet.";
    const shared = {
      terms: ["lantern"],
      documents: 50,
      documentFrequency: new Map([["lantern", 1]]),
      vectorsAvailable: true,
      backgroundCosine: 0.2,
      thresholds: defaultGroundingThresholds,
    };
    const fromNew = explainStoredGrounding({
      ...shared,
      passages: [
        { text: passage, vectors: vectorsFor(scored(produced), lantern.id) },
      ],
    });
    const fromOld = explainStoredGrounding({
      ...shared,
      passages: [{ text: passage, vectors: vectorsFor(legacy, lantern.id) }],
    });
    assert.equal(fromOld.label, "strong");
    assert.deepEqual(fromNew, fromOld);

    const pack = buildContextPackage(
      store,
      knowledge,
      { scope, question: "where is the lantern" },
      semantic,
    );
    const report = searchGroundingReport(pack);
    assert.equal(pack.grounding, "strong", JSON.stringify(report));
    assert.equal(report?.cosine, 0.5);
    assert.equal(report?.cosineSource, "vector");
    assert.equal(report?.label, fromOld.label);
  } finally {
    await index.close();
    knowledge.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "grounding stays under a second for a few thousand records",
  { timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "grounding-perf-"));
    const path = join(dir, "db");
    const sourcesN = 2500;
    const knowledgeN = 2500;
    const chunks = 8;
    const dimensions = 384;
    {
      const store = new SourceStore(path);
      const knowledge = new KnowledgeStore(path);
      knowledge.close();
      store.close();
    }
    const db = new DatabaseSync(path);
    registerSearchFunctions(db);
    const vector = blob(Array.from({ length: dimensions }, () => 0));
    const insertSource = db.prepare(
      "INSERT INTO sources (id, text, origin, scope, captured_at, checksum, status) VALUES (?, ?, 'fixture', 'studio', '2024-01-01T00:00:00.000Z', ?, 'unreviewed')",
    );
    const insertKnowledge = db.prepare(
      "INSERT INTO knowledge_items (id, scope, kind, text, source_refs, creator, created_at) VALUES (?, 'studio', 'observation', ?, ?, ?, '2024-01-02T00:00:00.000Z')",
    );
    const insertChunk = db.prepare(
      "INSERT INTO embedding_chunks (kind, record_id, scope, chunk, offset, model, vector) VALUES (?, ?, 'studio', ?, ?, ?, ?)",
    );
    const creator = JSON.stringify({ kind: "user", name: "fixture" });
    const checksum = "ab".repeat(32);
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < sourcesN; i++) {
      const id = `s${String(i).padStart(5, "0")}`;
      insertSource.run(
        id,
        `lantern memory backup restore protocol note ${i} raretoken${i}`,
        checksum,
      );
      for (let chunk = 0; chunk < chunks; chunk++)
        insertChunk.run("sources", id, chunk, chunk * 192, model, vector);
    }
    for (let i = 0; i < knowledgeN; i++) {
      const id = `k${String(i).padStart(5, "0")}`;
      insertKnowledge.run(
        id,
        `lantern memory backup observation ${i} knowtoken${i}`,
        JSON.stringify([{ sourceId: `s${String(i).padStart(5, "0")}` }]),
        creator,
      );
      for (let chunk = 0; chunk < chunks; chunk++)
        insertChunk.run(
          "knowledge_items",
          id,
          chunk,
          chunk * 192,
          model,
          vector,
        );
    }
    db.exec("COMMIT");
    db.close();

    const store = new SourceStore(path);
    const knowledge = new KnowledgeStore(path);
    const index = new EmbeddingIndex(path, {
      version: model,
      async embed() {
        return new Float32Array(dimensions);
      },
    });
    const run = async () => {
      const phases = emptyPhases();
      const semantic = await index.search(
        { scope: "studio", question: "lantern memory backup" },
        phases,
      );
      const pack = buildContextPackage(
        store,
        knowledge,
        { scope: "studio", question: "lantern memory backup" },
        semantic,
        undefined,
        undefined,
        phases,
      );
      return { phases, label: pack.grounding };
    };
    try {
      const first = await run();
      const second = await run();
      assert.equal(second.label, first.label);
      assert.ok(
        second.phases.groundingMs < 1000,
        `warm groundingMs ${second.phases.groundingMs} centroid ${second.phases.centroidMs} frequency ${second.phases.frequencyMs} passage ${second.phases.passageMs}`,
      );
    } finally {
      await index.close();
      knowledge.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
