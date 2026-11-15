import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { seedProjectEvalCorpus } from "./fixtures/project-eval-corpus.js";

const dir = await mkdtemp(".output/project-eval-");
try {
  const databasePath = join(dir, "context.db");
  seedProjectEvalCorpus(databasePath);
  const result = spawnSync(
    process.execPath,
    [
      "dist/scripts/context.js",
      "eval",
      "projects",
      "--questions",
      "fixtures/evals/projects.yaml",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTEXT_DB_PATH: databasePath,
        CONTEXT_AREAS: "projects",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    recall_at_k: number;
    pack_hit_rate: number;
    isolation_violations: number;
    questions: { id: string; pass: boolean | null; outranks_pass?: boolean }[];
    projects: { project: string; recall_at_k: number; pack_hit_rate: number }[];
  };
  assert.equal(report.isolation_violations, 0);
  assert.equal(report.recall_at_k, 1);
  assert.equal(report.pack_hit_rate, 1);
  for (const project of report.projects) {
    assert.equal(project.recall_at_k, 1, project.project);
    assert.equal(project.pack_hit_rate, 1, project.project);
  }
  const distill = report.questions.find(
    (question) => question.id === "context_nightly_distill",
  );
  assert.equal(distill?.pass, true);
  assert.equal(distill?.outranks_pass, true);
  assert.equal(result.stdout.includes("улучшить"), false);
  process.stdout.write(
    `${report.projects.map((project) => `${project.project} recall ${project.recall_at_k} pack-hit ${project.pack_hit_rate}`).join("; ")}\n`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
