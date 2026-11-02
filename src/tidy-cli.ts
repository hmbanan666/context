import { tidyOptions } from "./automatic-tidy.js";
import { runTidy } from "./tidy.js";

export async function tidyCommand(args: string[], env: NodeJS.ProcessEnv) {
  let dryRun = false,
    json = false;
  let area: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i] ?? "";
    if (seen.has(key)) throw new Error("Duplicate tidy option");
    seen.add(key);
    if (key === "--dry-run") dryRun = true;
    else if (key === "--json") json = true;
    else if (key === "--area" && args[i + 1] && !args[i + 1]?.startsWith("--"))
      area = args[++i];
    else throw new Error("Invalid tidy option");
  }
  const run = await runTidy({
    ...tidyOptions(env.CONTEXT_DB_PATH ?? "./data/context.db", env),
    dryRun,
    ...(area ? { area } : {}),
  });
  process.stdout.write(
    `${json ? JSON.stringify(run) : `${run.dryRun ? "Dry run" : "Tidy"}: ${run.outcome}; duplicates ${run.duplicates}, moved ${run.moved}, uncertain ${run.uncertain}, failures ${run.failures}; llm ${run.llm}`}\n`,
  );
  if (run.outcome !== "completed") process.exitCode = 1;
}
