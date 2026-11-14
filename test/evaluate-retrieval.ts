import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { seedEvalCorpus } from "./fixtures/eval-corpus.js";
import { seedProjectMemoryCorpus } from "./fixtures/project-memory-corpus.js";

await mkdir(".output", { recursive: true });

async function runEval(
  questions: string,
  areas: string,
  seed: (path: string) => void,
) {
  const dir = await mkdtemp(".output/eval-ci-");
  try {
    const databasePath = join(dir, "context.db");
    seed(databasePath);
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
        encoding: "utf8",
        env: {
          ...process.env,
          CONTEXT_DB_PATH: databasePath,
          CONTEXT_AREAS: areas,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(result.stdout);
    return JSON.parse(result.stdout) as {
      metrics: { isolation_violations: number; hit_at_k: number | null };
      questions: { id: string; pass: boolean | null; status: string }[];
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const example = await runEval(
  "fixtures/evals/example.yaml",
  "garden,vault",
  seedEvalCorpus,
);
assert.equal(example.metrics.isolation_violations, 0);
for (const id of [
  "exact_en",
  "exact_ru",
  "denied_area",
  "current_over_history",
  "duplicate_only_match",
])
  assert.equal(example.questions.find((q) => q.id === id)?.pass, true, id);

const projectMemory = await runEval(
  "fixtures/evals/project-memory.yaml",
  "workshop",
  seedProjectMemoryCorpus,
);
assert.equal(projectMemory.metrics.isolation_violations, 0);
assert.equal(
  projectMemory.questions.find((q) => q.id === "october_on_project")?.pass,
  true,
);
assert.equal(projectMemory.metrics.hit_at_k, 1);
for (const id of ["pack_for_task", "pack_budget"])
  assert.equal(
    projectMemory.questions.find((q) => q.id === id)?.status,
    "skipped",
    id,
  );
