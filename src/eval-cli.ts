import { evalConfig } from "./eval-config.js";
import { appendEvalRun, evalHistory } from "./eval-history.js";
import { type EvalRun, evaluate } from "./eval-runner.js";

export function evalExitCode(run: EvalRun) {
  return run.metrics.isolation_violations > 0
    ? 2
    : run.outcome === "failed"
      ? 1
      : 0;
}
export async function evalCommand(args: string[], env: NodeJS.ProcessEnv) {
  const [action, ...rest] = args;
  if (action !== "run" && action !== "history")
    throw new Error("Invalid eval command");
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
    const run = await evaluate(config);
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

function formatRun(run: EvalRun) {
  return `${run.timestamp} ${run.id} ${run.outcome}\n  ${JSON.stringify(run.metrics)}\n  ${run.questions.map((q) => `${q.id}:${q.pass === null ? "skip" : q.pass ? "pass" : "fail"}`).join(" ")}`;
}
