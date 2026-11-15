import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { KnowledgeStore } from "../src/knowledge.js";
import { appendProjectEval, evaluateProjects } from "../src/project-eval.js";
import { SourceStore } from "../src/store.js";
import { seedProjectEvalCorpus } from "./fixtures/project-eval-corpus.js";

test("project eval reports per-project recall and the distillation pack", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-project-eval-"));
  const path = join(directory, "context.db");
  seedProjectEvalCorpus(path);
  try {
    const report = await evaluateProjects({
      databasePath: path,
      directory: join(directory, "evals"),
      areas: ["projects"],
      questionsPath: "fixtures/evals/projects.yaml",
      k: 10,
    });
    assert.equal(report.outcome, "completed");
    assert.equal(report.isolation_violations, 0);
    assert.equal(report.recall_at_k, 1);
    assert.equal(report.pack_hit_rate, 1);
    assert.equal(report.search.semantic, "unavailable");
    const projects = Object.fromEntries(
      report.projects.map((project) => [project.project, project]),
    );
    assert.equal(projects.context?.questions, 12);
    assert.equal(projects.context?.recall_at_k, 1);
    assert.equal(projects.context?.pack_hit_rate, 1);
    assert.equal(projects.expi?.questions, 12);
    assert.equal(projects.expi?.recall_at_k, 1);
    assert.equal(projects.expi?.pack_hit_rate, 1);
    const distill = report.questions.find(
      (question) => question.id === "context_nightly_distill",
    );
    assert.equal(distill?.pass, true);
    assert.equal(distill?.pack_hit, true);
    assert.equal(distill?.outranks_pass, true);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("улучшить"), false);
    assert.equal(serialized.includes("distills each source"), false);
    await appendProjectEval(join(directory, "evals"), report);
    const history = await readFile(
      join(directory, "evals", "projects-history.jsonl"),
      "utf8",
    );
    assert.equal(history.includes("улучшить"), false);
    assert.equal(history.includes("distills each source"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project eval accepts an item id from a caller-supplied questions file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-project-item-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  try {
    sources.createProject({ id: "context", name: "Context", homeArea: "lab" });
    const source = sources.captureMaterial(
      {
        version: 1,
        scope: "lab",
        origin: "synthetic:item",
        idempotencyKey: "item",
        text: "Synthetic distillation note.",
        metadata: { createdAt: "2026-11-03T00:00:00.000Z" },
      },
      undefined,
      ["context"],
    ).material.source;
    const item = knowledge.addDistilled({
      scope: "lab",
      sourceId: source.id,
      kind: "decision",
      text: "Nightly tidy distills the fictional note.",
      createdAt: "2026-11-03T00:00:00.000Z",
    }).item;
    const questions = join(directory, "questions.yaml");
    await writeFile(
      questions,
      `questions:
  - id: by_item
    question: улучшить ночную дистилляцию
    areas: [lab]
    read_areas: [lab]
    project: context
    expected:
      - item_id: ${item.id}
`,
    );
    sources.setGlossaryTerm({
      projectId: "context",
      term: "дистилляция",
      synonyms: ["distill", "distillation", "tidy"],
    });
    const report = await evaluateProjects({
      databasePath: path,
      directory,
      areas: ["lab"],
      questionsPath: questions,
      k: 5,
    });
    assert.equal(report.questions[0]?.pass, true);
    assert.equal(report.questions[0]?.recall, 1);
    assert.equal(report.recall_at_k, 1);
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
