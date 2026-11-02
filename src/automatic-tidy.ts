import { evalConfig } from "./eval-config.js";
import { createLlm } from "./llm.js";
import { runTidy } from "./tidy.js";

export function tidyOptions(databasePath: string, env: NodeJS.ProcessEnv) {
  const { areas } = evalConfig({ ...env, CONTEXT_DB_PATH: databasePath });
  const llm = createLlm(env);
  return { databasePath, areas, ...(llm ? { llm } : {}) };
}
// Shares the backup schedule; failures must not prevent the subsequent eval.
export async function runTidyAfterBackup(
  databasePath: string,
  env: NodeJS.ProcessEnv,
) {
  try {
    const run = await runTidy(tidyOptions(databasePath, env));
    console.log(JSON.stringify({ event: "tidy", ...run }));
  } catch {
    console.error(JSON.stringify({ event: "tidy", outcome: "failed" }));
  }
}
