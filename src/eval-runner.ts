import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
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
  hit_at_1: number | null;
  hit_at_k: number | null;
  mrr: number | null;
  isolation_violations: number;
  latency_ms: number | null;
}
export interface EvalRun {
  schema_version: 1;
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
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
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
        ? hit.externalId === expected.source_external_id
        : hit.excerpts.some((excerpt) => excerpt.includes(expected.substring));
  const ranks = question.expected.map(
    (expected) => hits.findIndex((hit) => matches(expected, hit)) + 1,
  );
  const found = ranks.filter((rank) => rank > 0);
  return {
    hit_at_1: ranks.length ? Number(found.includes(1)) : null,
    hit_at_k: ranks.length ? found.length / ranks.length : null,
    mrr: ranks.length ? (found.length ? 1 / Math.min(...found) : 0) : null,
  };
}
export async function evaluate(options: EvalOptions): Promise<EvalRun> {
  const run: EvalRun = {
    schema_version: 1,
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
        hit_at_1: null,
        hit_at_k: null,
        mrr: null,
        isolation_violations: 0,
        latency_ms: null,
      };
      run.questions.push(result);
      if (q.placeholder) continue;
      const start = performance.now();
      try {
        const retrieved = await retrieveForEval(
          options.databasePath,
          q,
          options.k,
        );
        Object.assign(result, scoreEval(q, retrieved.hits));
        result.isolation_violations = retrieved.isolationViolations;
        result.status = retrieved.failed ? "failed" : "completed";
        if (retrieved.failed) run.outcome = "failed";
        result.pass =
          !retrieved.failed &&
          (result.hit_at_k === null || result.hit_at_k === 1) &&
          !result.isolation_violations;
      } catch {
        result.status = "failed";
        result.pass = false;
        run.outcome = "failed";
        if (q.expected.length)
          Object.assign(result, { hit_at_1: 0, hit_at_k: 0, mrr: 0 });
      }
      result.latency_ms = performance.now() - start;
    }
  } catch {
    run.outcome = "failed";
  }
  const mean = (key: "hit_at_1" | "hit_at_k" | "mrr") => {
    const values = run.questions.flatMap((q) =>
      q[key] === null ? [] : [q[key]],
    );
    return values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
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
  return run;
}
