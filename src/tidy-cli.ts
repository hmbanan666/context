import { tidyOptions } from "./automatic-tidy.js";
import { runTidy } from "./tidy.js";

export async function tidyCommand(args: string[], env: NodeJS.ProcessEnv) {
  let dryRun = false,
    json = false,
    journalBackfill = false;
  let area: string | undefined;
  let journalBackfillLimit: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i] ?? "";
    if (seen.has(key)) throw new Error("Duplicate tidy option");
    seen.add(key);
    if (key === "--dry-run") dryRun = true;
    else if (key === "--json") json = true;
    else if (key === "--journal-backfill") journalBackfill = true;
    else if (
      key === "--journal-backfill-limit" &&
      args[i + 1] &&
      !args[i + 1]?.startsWith("--")
    )
      journalBackfillLimit = Number(args[++i]);
    else if (key === "--area" && args[i + 1] && !args[i + 1]?.startsWith("--"))
      area = args[++i];
    else throw new Error("Invalid tidy option");
  }
  const run = await runTidy({
    ...tidyOptions(env.CONTEXT_DB_PATH ?? "./data/context.db", env),
    dryRun,
    ...(area ? { area } : {}),
    ...(journalBackfill ? { journalBackfill } : {}),
    ...(journalBackfillLimit !== undefined ? { journalBackfillLimit } : {}),
  });
  const abandoned = [...run.llmFailures]
    .reverse()
    .find((failure) => failure.abandoned);
  const llmDetail = abandoned
    ? ` (${abandoned.reason}${abandoned.exitCode !== null ? ` exit ${abandoned.exitCode}` : ""})`
    : "";
  process.stdout.write(
    `${json ? JSON.stringify(run) : `${run.dryRun ? "Dry run" : "Tidy"}: ${run.outcome}; duplicates ${run.duplicates}, moved ${run.moved}, uncertain ${run.uncertain}, failures ${run.failures}; llm ${run.llm}${llmDetail}; distillation ${run.distillStatus} (${run.distilled}, rejected ${run.distillRejected}); journals ${run.journals}`}\n`,
  );
  if (run.outcome !== "completed") process.exitCode = 1;
}
