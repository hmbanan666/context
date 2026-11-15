import { dirname, join } from "node:path";
import { evalConfig } from "./eval-config.js";
import { appendEvalRun, evalHistory } from "./eval-history.js";
import type { EvalRun } from "./eval-runner.js";
import { evaluateWithLocalModel } from "./eval-search.js";
import {
  appendProjectEval,
  evaluateProjects,
  formatProjectEval,
} from "./project-eval.js";
import { EmbeddingIndex } from "./embedding-index.js";
import { localEmbedder } from "./embedding-model.js";

export function evalExitCode(run: EvalRun) {
  return run.metrics.isolation_violations > 0
    ? 2
    : run.outcome === "failed"
      ? 1
      : 0;
}
async function evaluateProjectsWithLocalModel(
  options: ReturnType<typeof evalConfig>,
) {
  let index: EmbeddingIndex | undefined;
  try {
    index = new EmbeddingIndex(options.databasePath, localEmbedder(), {
      readOnly: true,
    });
    if (index.hasVectors()) await index.load().catch(() => {});
    return await evaluateProjects(options, index);
  } finally {
    await index?.close();
  }
}

export async function evalCommand(args: string[], env: NodeJS.ProcessEnv) {
  const [action, ...rest] = args;
  if (action !== "run" && action !== "history" && action !== "projects")
    throw new Error("Invalid eval command");
  if (action === "projects") {
    const config = evalConfig(env);
    config.questionsPath = join(
      dirname(config.databasePath),
      "evals",
      "projects.yaml",
    );
    let json = false;
    const seen = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i] ?? "";
      if (seen.has(key)) throw new Error("Duplicate eval option");
      seen.add(key);
      if (key === "--json") {
        json = true;
        continue;
      }
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new Error("Missing eval option");
      if (key === "--questions") config.questionsPath = value;
      else if (key === "--k" && /^(?:[1-9]|1[0-9]|20)$/.test(value))
        config.k = Number(value);
      else throw new Error("Invalid eval option");
    }
    const report = await evaluateProjectsWithLocalModel(config);
    await appendProjectEval(config.directory, report);
    process.stdout.write(
      `${json ? JSON.stringify(report) : formatProjectEval(report)}\n`,
    );
    process.exitCode =
      report.isolation_violations > 0 ? 2 : report.outcome === "failed" ? 1 : 0;
    return;
  }
  const config = evalConfig(env);
  let json = false;
  let limit = 10;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i] ?? "";
    if (seen.has(key)) throw new Error("Duplicate eval option");
    seen.add(key);
    if (key === "--json") {
      json = true;
      continue;
    }
    const value = rest[++i];
    if (!value || value.startsWith("--"))
      throw new Error("Missing eval option");
    if (key === "--questions" && action === "run") config.questionsPath = value;
    else if (
      key === "--k" &&
      action === "run" &&
      /^(?:[1-9]|1[0-9]|20)$/.test(value)
    )
      config.k = Number(value);
    else if (
      key === "--limit" &&
      action === "history" &&
      /^(?:[1-9]|[1-9][0-9]|100)$/.test(value)
    )
      limit = Number(value);
    else throw new Error("Invalid eval option");
  }
  if (action === "run") {
    const run = await evaluateWithLocalModel(config);
    await appendEvalRun(config.directory, run);
    process.stdout.write(`${json ? JSON.stringify(run) : formatRun(run)}\n`);
    process.exitCode = evalExitCode(run);
  } else {
    const runs = await evalHistory(config.directory, limit);
    process.stdout.write(
      `${json ? JSON.stringify(runs) : runs.map((r) => `${formatRun(r)}\n  delta previous: ${JSON.stringify(r.delta_previous)}`).join("\n")}\n`,
    );
  }
}

export function formatRun(run: EvalRun) {
  const { lexical, ...diagnostics } = run.diagnostics ?? {};
  const control = lexical
    ? `\n  lexical control: hit@1 ${lexical.hit_at_1} hit@${run.k} ${lexical.hit_at_k} mrr ${lexical.mrr}`
    : "";
  const search = run.search
    ? `search: ${run.search.mode}; semantic: ${run.search.semantic}; model: ${run.search.model}`
    : "search: unrecorded (legacy row)";
  return `${run.timestamp} ${run.id} ${run.outcome}\n  ${search}\n  ${JSON.stringify(diagnostics)}\n  ${JSON.stringify(run.metrics)}${control}\n  ${run.questions.map((q) => `${q.id}:${q.pass === null ? "skip" : q.pass ? "pass" : "fail"}`).join(" ")}`;
}
