import { access } from "node:fs/promises";
import type { EmbeddingIndex } from "./embedding-index.js";
import { evalExitCode } from "./eval-cli.js";
import { evalConfig } from "./eval-config.js";
import { appendEvalRun } from "./eval-history.js";
import { evaluate } from "./eval-runner.js";

// Called only after a scheduled backup attempt. No independent timer or settings.
export async function runEvalAfterBackup(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  embeddings?: EmbeddingIndex,
) {
  try {
    const options = evalConfig({ ...env, CONTEXT_DB_PATH: databasePath });
    try {
      await access(options.questionsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const run = await evaluate(options, embeddings);
    await appendEvalRun(options.directory, run);
    console.log(
      JSON.stringify({
        event: "eval",
        outcome: evalExitCode(run) ? "failed" : "completed",
        metrics: run.metrics,
        search: run.search,
        diagnostics: run.diagnostics,
      }),
    );
  } catch {
    console.error(JSON.stringify({ event: "eval", outcome: "failed" }));
  }
}
