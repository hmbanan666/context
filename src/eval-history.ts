import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EvalMetrics, EvalRun } from "./eval-runner.js";

export async function appendEvalRun(directory: string, run: EvalRun) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(directory, "history.jsonl"),
    `${JSON.stringify(run)}\n`,
    { mode: 0o600 },
  );
}
export async function evalHistory(directory: string, limit = 10) {
  const input = createReadStream(join(directory, "history.jsonl"), {
    encoding: "utf8",
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const runs: EvalRun[] = [];
  try {
    // Keep only the displayed window plus its predecessor, even after years of runs.
    for await (const line of lines) {
      if (!line.trim()) continue;
      runs.push(JSON.parse(line) as EvalRun);
      if (runs.length > limit + 1) runs.shift();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return runs
    .map((run, i) => {
      const previous = runs[i - 1];
      let delta: EvalMetrics | null = null;
      if (
        previous &&
        run.outcome === "completed" &&
        previous.outcome === "completed" &&
        run.question_file_hash === previous.question_file_hash &&
        run.k === previous.k &&
        run.schema_version === previous.schema_version
      ) {
        delta = Object.fromEntries(
          Object.entries(run.metrics).map(([key, value]) => {
            const before = previous.metrics[key as keyof EvalMetrics];
            return [
              key,
              value === null || before === null ? null : value - before,
            ];
          }),
        ) as unknown as EvalMetrics;
      }
      return {
        ...run,
        previous_id: previous?.id ?? null,
        delta_previous: delta,
      };
    })
    .slice(-limit)
    .reverse();
}
