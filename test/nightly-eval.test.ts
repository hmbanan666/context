import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { startAutomaticBackups } from "../src/automatic-backup.js";
import type { BackupClock } from "../src/backup-scheduler.js";
import { evalHistory } from "../src/eval-history.js";
import { seedEvalCorpus } from "./fixtures/eval-corpus.js";

class Clock implements BackupClock {
  date = new Date("2026-11-02T02:29:00Z");
  pending: (() => void) | undefined;
  now() {
    return this.date;
  }
  later(callback: () => void) {
    this.pending = callback;
    return () => {
      this.pending = undefined;
    };
  }
  advance(iso: string) {
    this.date = new Date(iso);
    this.pending?.();
  }
}

test("nightly backup triggers eval afterward using the same schedule and persists content-free JSONL", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  const clock = new Clock();
  const databasePath = join(dir, "context.db");
  const directory = join(dir, "evals");
  seedEvalCorpus(databasePath);
  const env = {
    CONTEXT_AREAS: "garden,vault",
    CONTEXT_BACKUP_DIR: join(dir, "backups"),
    TZ: "Europe/Berlin",
  };
  try {
    await mkdir(directory);
    await writeFile(
      join(directory, "questions.yaml"),
      await readFile("fixtures/evals/example.yaml"),
    );
    let scheduler = await startAutomaticBackups(databasePath, env, clock);
    assert.equal((await evalHistory(directory)).length, 0);
    clock.advance("2026-11-02T02:30:00Z");
    await scheduler.stop();
    let rows = await evalHistory(directory);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.metrics.isolation_violations, 0);
    const backup = JSON.parse(
      await readFile(join(dir, "backups", "status.json"), "utf8"),
    );
    assert.equal(backup.outcome, "success");
    const tidy = JSON.parse(
      (await readFile(join(dir, "tidy/history.jsonl"), "utf8")).trim(),
    );
    assert.equal(tidy.outcome, "completed");
    assert.ok(
      Date.parse(tidy.timestamp) >=
        Date.parse(backup.startedAt) + Math.floor(backup.durationMs),
    );
    assert.ok(
      Date.parse(rows[0]?.timestamp ?? "") >=
        Date.parse(tidy.timestamp) + tidy.durationMs - 1,
    );
    assert.ok(
      Date.parse(rows[0]?.timestamp ?? "") >=
        Date.parse(backup.startedAt) + Math.floor(backup.durationMs),
    );
    scheduler = await startAutomaticBackups(databasePath, env, clock);
    await scheduler.stop();
    assert.equal((await evalHistory(directory)).length, 1);
    await writeFile(
      join(directory, "questions.yaml"),
      "PRIVATE-FICTIONAL-CONTENT: [",
    );
    clock.date = new Date("2026-11-03T05:00:00Z");
    scheduler = await startAutomaticBackups(databasePath, env, clock);
    await scheduler.stop();
    rows = await evalHistory(directory);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.outcome, "failed");
    assert.ok(!JSON.stringify(rows).includes("PRIVATE-FICTIONAL-CONTENT"));
    assert.ok(
      !(await readFile(join(directory, "history.jsonl"), "utf8")).includes(
        "PRIVATE-FICTIONAL-CONTENT",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nightly backup skips absent questions and backup off disables both jobs", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  try {
    const clock = new Clock();
    clock.date = new Date("2026-11-02T05:00:00Z");
    const path = join(dir, "context.db");
    seedEvalCorpus(path);
    const env = {
      CONTEXT_BACKUP_DIR: join(dir, "backups"),
      TZ: "UTC",
    };
    const scheduler = await startAutomaticBackups(path, env, clock);
    await scheduler.stop();
    assert.equal((await evalHistory(join(dir, "evals"))).length, 0);
    await mkdir(join(dir, "evals"));
    await writeFile(
      join(dir, "evals", "questions.yaml"),
      await readFile("fixtures/evals/example.yaml"),
    );
    const off = await startAutomaticBackups(
      path,
      { ...env, CONTEXT_BACKUP_AT: "off" },
      clock,
    );
    await off.stop();
    assert.equal((await evalHistory(join(dir, "evals"))).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nightly eval reuses the service model and index without loading or closing another model", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const { readConfig } = await import("../src/config.js");
  const { startService } = await import("../src/server.js");
  const dir = await mkdtemp(join(process.cwd(), ".output-eval-"));
  const databasePath = join(dir, "context.db");
  const directory = join(dir, "evals");
  let loads = 0,
    closes = 0;
  const embedder = {
    version: "synthetic-nightly-v1",
    async load() {
      loads++;
    },
    async embed() {
      return Float32Array.from([1, 0]);
    },
    async close() {
      closes++;
    },
  };
  seedEvalCorpus(databasePath);
  const seed = new EmbeddingIndex(databasePath, embedder);
  while (await seed.processOne()) {
    /* prepare synthetic vectors */
  }
  await seed.close();
  closes = 0;
  const env = {
    CONTEXT_DB_PATH: databasePath,
    CONTEXT_AREAS: "garden,vault",
    CONTEXT_BACKUP_DIR: join(dir, "backups"),
    TZ: "UTC",
    CONTEXT_PORT: "0",
  };
  const service = await startService(readConfig(env), embedder);
  try {
    await mkdir(directory);
    await writeFile(
      join(directory, "questions.yaml"),
      JSON.stringify({
        questions: [
          {
            id: "vector_only",
            question: "Как восстановить наблюдения?",
            areas: ["garden"],
            read_areas: ["garden"],
            forbidden_areas: ["vault"],
            expected: [
              { source_external_id: "https://fictional.example/iris" },
            ],
          },
        ],
      }),
    );
    const clock = new Clock();
    clock.date = new Date("2026-11-02T05:00:00Z");
    const scheduler = await startAutomaticBackups(
      databasePath,
      env,
      clock,
      service.embeddings,
    );
    await scheduler.stop();
    const [run] = await evalHistory(directory);
    assert.equal(run?.search.mode, "hybrid");
    assert.equal(run?.search.model, embedder.version);
    assert.equal(run?.diagnostics.vector_only_questions, 1);
    assert.equal(run?.metrics.isolation_violations, 0);
    assert.equal(loads, 1);
    assert.equal(closes, 0);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(closes, 1);
});
