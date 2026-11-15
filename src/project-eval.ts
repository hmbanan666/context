import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingIndex } from "./embedding-index.js";
import { E5_VERSION } from "./embedding-model.js";
import { readEvalQuestions } from "./eval-questions.js";
import { retrieveForEval } from "./eval-retrieval.js";
import { evalHitMatches, scoreEval, type EvalOptions } from "./eval-runner.js";

export interface ProjectEvalQuestionResult {
  id: string;
  project: string;
  mode: "search" | "pack";
  status: "completed" | "skipped" | "failed";
  pass: boolean | null;
  recall: number | null;
  pack_hit: boolean | null;
  isolation_violations: number;
  outranks_pass?: boolean | null;
}
export interface ProjectEvalProject {
  project: string;
  questions: number;
  recall_at_k: number | null;
  pack_questions: number;
  pack_hits: number;
  pack_hit_rate: number | null;
}
export interface ProjectEvalReport {
  schema_version: 1;
  question_file_hash: string | null;
  k: number;
  outcome: "completed" | "failed";
  search: {
    mode: "lexical" | "hybrid";
    model: string;
    semantic: "available" | "unavailable" | "partial";
  };
  isolation_violations: number;
  recall_at_k: number | null;
  pack_hit_rate: number | null;
  projects: ProjectEvalProject[];
  questions: ProjectEvalQuestionResult[];
}

function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Per-project recall@k and pack-hit rate. The questions file is the caller's:
// a private prod file or the synthetic fixture. No corpus writes.
export async function evaluateProjects(
  options: EvalOptions,
  embeddings?: EmbeddingIndex,
): Promise<ProjectEvalReport> {
  let semanticUsed = false;
  let semanticUnavailable = false;
  const report: ProjectEvalReport = {
    schema_version: 1,
    question_file_hash: null,
    k: options.k,
    outcome: "completed",
    search: {
      mode: "lexical",
      model: embeddings?.model ?? E5_VERSION,
      semantic: "unavailable",
    },
    isolation_violations: 0,
    recall_at_k: null,
    pack_hit_rate: null,
    projects: [],
    questions: [],
  };
  const file = await readEvalQuestions(options.questionsPath);
  report.question_file_hash = file.hash;
  if (
    file.questions.some((question) =>
      [
        ...question.areas,
        ...question.read_areas,
        ...question.forbidden_areas,
      ].some((area) => !options.areas.includes(area)),
    )
  )
    throw new Error("Unknown eval area");
  for (const question of file.questions) {
    if (!question.placeholder && question.project === undefined)
      throw new Error("Project eval questions require a project");
  }
  for (const question of file.questions) {
    const result: ProjectEvalQuestionResult = {
      id: question.id,
      project: question.project ?? "",
      mode: question.mode === "pack" ? "pack" : "search",
      status: "skipped",
      pass: null,
      recall: null,
      pack_hit: null,
      isolation_violations: 0,
    };
    report.questions.push(result);
    if (question.placeholder) continue;
    try {
      const retrieved = await retrieveForEval(
        options.databasePath,
        question,
        options.k,
        embeddings,
      );
      semanticUsed ||= retrieved.semanticUsed;
      semanticUnavailable ||= retrieved.semanticUnavailable;
      const scored = scoreEval(question, retrieved.hits);
      const found = question.expected.filter((expected) =>
        retrieved.hits.some((hit) => evalHitMatches(expected, hit)),
      ).length;
      const recall = question.expected.length
        ? found / question.expected.length
        : null;
      const outranks = scored.outranks_pass;
      if (outranks !== undefined) result.outranks_pass = outranks;
      result.recall = recall;
      result.isolation_violations = retrieved.isolationViolations;
      result.status = retrieved.failed ? "failed" : "completed";
      if (retrieved.failed) report.outcome = "failed";
      const ok =
        !retrieved.failed &&
        recall === 1 &&
        retrieved.isolationViolations === 0 &&
        retrieved.forbiddenHits === 0 &&
        outranks !== false &&
        (question.expect_truncated === undefined ||
          retrieved.truncated === question.expect_truncated);
      result.pass = ok;
      result.pack_hit = question.mode === "pack" ? ok : null;
    } catch {
      result.status = "failed";
      result.pass = false;
      result.recall = question.expected.length ? 0 : null;
      result.pack_hit = question.mode === "pack" ? false : null;
      if (question.outranks) result.outranks_pass = false;
      report.outcome = "failed";
    }
    report.isolation_violations += result.isolation_violations;
  }
  report.search.mode = semanticUsed ? "hybrid" : "lexical";
  report.search.semantic = semanticUsed
    ? semanticUnavailable
      ? "partial"
      : "available"
    : "unavailable";
  const scored = report.questions.filter(
    (question) => question.status !== "skipped" && question.recall !== null,
  );
  report.recall_at_k = mean(scored.map((question) => question.recall ?? 0));
  const packs = report.questions.filter(
    (question) => question.pack_hit !== null && question.status !== "skipped",
  );
  report.pack_hit_rate = mean(
    packs.map((question) => (question.pack_hit ? 1 : 0)),
  );
  const byProject = new Map<string, ProjectEvalQuestionResult[]>();
  for (const question of report.questions) {
    if (question.status === "skipped" || !question.project) continue;
    const list = byProject.get(question.project) ?? [];
    list.push(question);
    byProject.set(question.project, list);
  }
  report.projects = [...byProject.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, questions]) => {
      const recalled = questions.filter((question) => question.recall !== null);
      const packQuestions = questions.filter(
        (question) => question.pack_hit !== null,
      );
      const packHits = packQuestions.filter(
        (question) => question.pack_hit,
      ).length;
      return {
        project,
        questions: questions.length,
        recall_at_k: mean(recalled.map((question) => question.recall ?? 0)),
        pack_questions: packQuestions.length,
        pack_hits: packHits,
        pack_hit_rate: mean(
          packQuestions.map((question) => (question.pack_hit ? 1 : 0)),
        ),
      };
    });
  return report;
}

export function formatProjectEval(report: ProjectEvalReport): string {
  const lines = [
    `search: ${report.search.mode}; semantic: ${report.search.semantic}; model: ${report.search.model}`,
    ...report.projects.map(
      (project) =>
        `${project.project}: questions ${project.questions} recall@${report.k} ${project.recall_at_k} pack-hit ${project.pack_hit_rate} (${project.pack_hits}/${project.pack_questions})`,
    ),
    `overall recall@${report.k} ${report.recall_at_k} pack-hit ${report.pack_hit_rate} isolation ${report.isolation_violations}`,
    report.questions
      .map(
        (question) =>
          `${question.id}:${question.pass === null ? "skip" : question.pass ? "pass" : "fail"}`,
      )
      .join(" "),
  ];
  return lines.join("\n");
}

export async function appendProjectEval(
  directory: string,
  report: ProjectEvalReport,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(directory, "projects-history.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      schema_version: report.schema_version,
      question_file_hash: report.question_file_hash,
      k: report.k,
      outcome: report.outcome,
      search: report.search,
      isolation_violations: report.isolation_violations,
      recall_at_k: report.recall_at_k,
      pack_hit_rate: report.pack_hit_rate,
      projects: report.projects,
      questions: report.questions.map((question) => ({
        id: question.id,
        project: question.project,
        mode: question.mode,
        status: question.status,
        pass: question.pass,
        recall: question.recall,
        pack_hit: question.pack_hit,
        isolation_violations: question.isolation_violations,
        ...(question.outranks_pass === undefined
          ? {}
          : { outranks_pass: question.outranks_pass }),
      })),
    })}\n`,
    { mode: 0o600 },
  );
}
