import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { performance } from "node:perf_hooks";
import type { EmbeddingIndex } from "./embedding-index.js";
import { E5_VERSION } from "./embedding-model.js";
import { type EvalQuestion, readEvalQuestions } from "./eval-questions.js";
import { type EvalHit, retrieveForEval } from "./eval-retrieval.js";

export interface EvalMetrics {
  hit_at_1: number | null;
  hit_at_k: number | null;
  mrr: number | null;
  isolation_violations: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
}
export interface EvalQuestionResult {
  id: string;
  status: "completed" | "skipped" | "failed";
  pass: boolean | null;
  outranks_pass?: boolean | null;
  hit_at_1: number | null;
  hit_at_k: number | null;
  mrr: number | null;
  isolation_violations: number;
  latency_ms: number | null;
}
export interface EvalRun {
  schema_version: 2;
  search: {
    mode: "lexical" | "hybrid";
    model: string;
    semantic: "available" | "unavailable" | "partial";
  };
  diagnostics: {
    compared_questions: number;
    vector_only_questions: number;
    lexical_only_questions: number;
    lexical?: Pick<EvalMetrics, "hit_at_1" | "hit_at_k" | "mrr">;
  };
  id: string;
  timestamp: string;
  git_sha: string | null;
  version: string;
  question_file_hash: string | null;
  k: number;
  outcome: "completed" | "failed";
  metrics: EvalMetrics;
  questions: EvalQuestionResult[];
}
export interface EvalOptions {
  databasePath: string;
  questionsPath: string;
  directory: string;
  areas: string[];
  k: number;
}
function version() {
  const packagePath = findPackageJSON(import.meta.url);
  if (!packagePath) throw new Error("Cannot locate the Context package");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
  let sha = process.env.GITHUB_SHA;
  if (!sha) {
    try {
      sha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* Images may contain only the package version. */
    }
  }
  return {
    version: pkg.version,
    git_sha: sha && /^[a-f0-9]{40,64}$/.test(sha) ? sha : null,
  };
}
export function scoreEval(question: EvalQuestion, hits: EvalHit[]) {
  const matches = (expected: EvalQuestion["expected"][number], hit: EvalHit) =>
    "source_id" in expected
      ? hit.id === expected.source_id
      : "source_external_id" in expected
        ? hit.externalIds.includes(expected.source_external_id)
        : hit.excerpts.some((excerpt) => excerpt.includes(expected.substring));
  const ranks = question.expected.map(
    (expected) => hits.findIndex((hit) => matches(expected, hit)) + 1,
  );
  const found = ranks.filter((rank) => rank > 0);
  return {
    ...(question.outranks
      ? {
          outranks_pass:
            found.length > 0 &&
            hits.every(
              (hit, index) =>
                !question.outranks?.some((m) => matches(m, hit)) ||
                Math.min(...found) < index + 1,
            ),
        }
      : {}),
    hit_at_1: ranks.length ? Number(found.includes(1)) : null,
    hit_at_k: ranks.length ? Number(found.length > 0) : null,
    mrr: ranks.length ? (found.length ? 1 / Math.min(...found) : 0) : null,
  };
}
export async function evaluate(
  options: EvalOptions,
  embeddings?: EmbeddingIndex,
): Promise<EvalRun> {
  let semanticUsed = false;
  let semanticUnavailable = false;
  const lexicalScores: ReturnType<typeof scoreEval>[] = [];
  const run: EvalRun = {
    schema_version: 2,
    search: {
      mode: "lexical",
      model: embeddings?.model ?? E5_VERSION,
      semantic: "unavailable",
    },
    diagnostics: {
      compared_questions: 0,
      vector_only_questions: 0,
      lexical_only_questions: 0,
    },
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...version(),
    question_file_hash: null,
    k: options.k,
    outcome: "completed",
    questions: [],
    metrics: {
      hit_at_1: null,
      hit_at_k: null,
      mrr: null,
      isolation_violations: 0,
      latency_p50_ms: null,
      latency_p95_ms: null,
    },
  };
  try {
    const file = await readEvalQuestions(options.questionsPath);
    run.question_file_hash = file.hash;
    if (
      file.questions.some((q) =>
        [...q.areas, ...q.read_areas, ...q.forbidden_areas].some(
          (a) => !options.areas.includes(a),
        ),
      )
    )
      throw new Error("Unknown eval area");
    for (const q of file.questions) {
      const result: EvalQuestionResult = {
        id: q.id,
        status: "skipped",
        pass: null,
        ...(q.outranks ? { outranks_pass: null } : {}),
        hit_at_1: null,
        hit_at_k: null,
        mrr: null,
        isolation_violations: 0,
        latency_ms: null,
      };
      run.questions.push(result);
      if (q.placeholder) continue;
      let violationKeys: string[] = [];
      let hybridScores: (number | null)[] = [];
      const start = performance.now();
      try {
        const retrieved = await retrieveForEval(
          options.databasePath,
          q,
          options.k,
          embeddings,
        );
        semanticUsed ||= retrieved.semanticUsed;
        semanticUnavailable ||= retrieved.semanticUnavailable;
        Object.assign(result, scoreEval(q, retrieved.hits));
        hybridScores = q.expected.map(
          (expected) =>
            scoreEval({ ...q, expected: [expected] }, retrieved.hits).hit_at_k,
        );
        violationKeys = retrieved.violationKeys;
        result.isolation_violations = retrieved.isolationViolations;
        result.status = retrieved.failed ? "failed" : "completed";
        if (retrieved.failed) run.outcome = "failed";
        result.pass =
          !retrieved.failed &&
          (result.hit_at_k === null || result.hit_at_k === 1) &&
          !result.isolation_violations &&
          result.outranks_pass !== false;
      } catch {
        result.status = "failed";
        result.pass = false;
        if (q.outranks) result.outranks_pass = false;
        run.outcome = "failed";
        if (q.expected.length)
          Object.assign(result, { hit_at_1: 0, hit_at_k: 0, mrr: 0 });
      }
      result.latency_ms = performance.now() - start;
      // The control uses the identical protected MCP path without vector candidates.
      // Keep its work out of the primary retrieval latency and quality metrics.
      if (embeddings && q.expected.length && result.status === "completed") {
        try {
          const lexical = await retrieveForEval(
            options.databasePath,
            q,
            options.k,
          );
          result.isolation_violations = new Set([
            ...violationKeys,
            ...lexical.violationKeys,
          ]).size;
          if (lexical.isolationViolations) result.pass = false;
          if (lexical.failed) throw new Error("Lexical control failed");
          // Compare each expected matcher, so a question with several sources can
          // contribute even when another expected source is found on both paths.
          const controlScores = q.expected.map(
            (expected) =>
              scoreEval({ ...q, expected: [expected] }, lexical.hits).hit_at_k,
          );
          run.diagnostics.compared_questions++;
          lexicalScores.push(scoreEval(q, lexical.hits));
          if (
            hybridScores.some(
              (found, i) => found === 1 && controlScores[i] === 0,
            )
          )
            run.diagnostics.vector_only_questions++;
          if (
            controlScores.some(
              (found, i) => found === 1 && hybridScores[i] === 0,
            )
          )
            run.diagnostics.lexical_only_questions++;
        } catch {
          run.outcome = "failed";
          result.status = "failed";
          result.pass = false;
        }
      }
    }
  } catch {
    run.outcome = "failed";
  }
  const mean = (
    key: "hit_at_1" | "hit_at_k" | "mrr",
    scores: Pick<
      EvalQuestionResult,
      "hit_at_1" | "hit_at_k" | "mrr"
    >[] = run.questions,
  ) => {
    const values = scores.flatMap((q) => (q[key] === null ? [] : [q[key]]));
    return values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
  };
  run.diagnostics.lexical = {
    hit_at_1: mean("hit_at_1", lexicalScores),
    hit_at_k: mean("hit_at_k", lexicalScores),
    mrr: mean("mrr", lexicalScores),
  };
  const latencies = run.questions
    .flatMap((q) => (q.latency_ms === null ? [] : [q.latency_ms]))
    .sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies[Math.ceil(latencies.length * p) - 1] ?? null;
  run.metrics = {
    hit_at_1: mean("hit_at_1"),
    hit_at_k: mean("hit_at_k"),
    mrr: mean("mrr"),
    isolation_violations: run.questions.reduce(
      (n, q) => n + q.isolation_violations,
      0,
    ),
    latency_p50_ms: percentile(0.5),
    latency_p95_ms: percentile(0.95),
  };
  run.search.mode = semanticUsed ? "hybrid" : "lexical";
  run.search.semantic = semanticUsed
    ? semanticUnavailable
      ? "partial"
      : "available"
    : "unavailable";
  return run;
}
