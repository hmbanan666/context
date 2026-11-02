import { dirname, join } from "node:path";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import type { EvalOptions } from "./eval-runner.js";

export function evalConfig(env: NodeJS.ProcessEnv): EvalOptions {
  const databasePath = env.CONTEXT_DB_PATH ?? "./data/context.db";
  const directory = join(dirname(databasePath), "evals");
  const areas = z
    .array(scopeSchema)
    .min(1)
    .max(8)
    .parse((env.CONTEXT_AREAS ?? "personal").split(","));
  if (
    !databasePath.trim() ||
    databasePath === ":memory:" ||
    !directory.trim() ||
    new Set(areas).size !== areas.length
  )
    throw new Error("Invalid eval configuration");
  return {
    databasePath,
    directory,
    areas,
    questionsPath: join(directory, "questions.yaml"),
    k: 10,
  };
}
