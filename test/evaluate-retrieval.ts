import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { seedEvalCorpus } from "./fixtures/eval-corpus.js";

await mkdir(".output", { recursive: true });
const dir = await mkdtemp(".output/eval-ci-");
try {
  const databasePath = join(dir, "context.db");
  seedEvalCorpus(databasePath);
  const result = spawnSync(
    process.execPath,
    [
      "dist/scripts/context.js",
      "eval",
      "run",
      "--questions",
      "fixtures/evals/example.yaml",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTEXT_DB_PATH: databasePath,
        CONTEXT_AREAS: "garden,vault",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.metrics.isolation_violations, 0);
  for (const id of [
    "exact_en",
    "exact_ru",
    "denied_area",
    "current_over_history",
    "duplicate_only_match",
  ])
    assert.equal(
      summary.questions.find((q: { id: string }) => q.id === id).pass,
      true,
      id,
    );
  process.stdout.write(`${result.stdout}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
