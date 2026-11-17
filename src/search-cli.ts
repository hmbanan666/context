import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { buildContextPackage } from "./context-package.js";
import { scopeSchema } from "./contracts.js";
import { KnowledgeStore } from "./knowledge.js";
import { contextPackageSchema } from "./package-query.js";
import { projectIdSchema } from "./projects.js";
import {
  buildTaskPack,
  packBudgetDefault,
  packBudgetMax,
  packBudgetMin,
} from "./task-pack.js";
import { presentSearchResult } from "./search-when-none.js";
import { SourceStore } from "./store.js";

const usage =
  "Usage: context search --query <text> --scope <area> [--project <id>] [--mode pack] [--budget-bytes <n>] [--since <iso>] [--until <iso>] [--k <n>]";

function databasePath(env: NodeJS.ProcessEnv): string {
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  return path;
}

function areas(env: NodeJS.ProcessEnv): string[] {
  const list = (env.CONTEXT_AREAS ?? "personal").split(",");
  if (list.length > 8 || new Set(list).size !== list.length)
    throw new Error("Invalid configured areas");
  try {
    for (const area of list) scopeSchema.parse(area);
  } catch {
    throw new Error("Invalid configured areas");
  }
  return list;
}

function text(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function searchCommand(args: string[], env: NodeJS.ProcessEnv): void {
  let values: Record<string, string | undefined>;
  try {
    const parsed = parseArgs({
      args,
      options: {
        query: { type: "string" },
        scope: { type: "string" },
        project: { type: "string" },
        mode: { type: "string" },
        "budget-bytes": { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        k: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
    values = {
      query: text(parsed.query),
      scope: text(parsed.scope),
      project: text(parsed.project),
      mode: text(parsed.mode),
      budget: text(parsed["budget-bytes"]),
      since: text(parsed.since),
      until: text(parsed.until),
      k: text(parsed.k),
    };
  } catch {
    throw new Error(usage);
  }
  const query = values.query;
  if (!query) throw new Error(usage);
  const configured = areas(env);
  const scope = values.scope ?? configured[0];
  if (!scope || !configured.includes(scope)) throw new Error("Unknown area");
  const mode = values.mode;
  if (mode !== undefined && mode !== "pack") throw new Error(usage);
  const project = values.project;
  if (project) {
    try {
      projectIdSchema.parse(project);
    } catch {
      throw new Error(usage);
    }
  }
  if (mode === "pack" && !project) throw new Error(usage);
  if (mode === "pack" && (values.since || values.until))
    throw new Error("pack mode does not take since or until");
  const budget = values.budget ? Number(values.budget) : packBudgetDefault;
  if (!Number.isInteger(budget)) throw new Error(usage);
  const sources = new SourceStore(databasePath(env));
  const knowledge = new KnowledgeStore(databasePath(env));
  try {
    if (project && !sources.hasProject(project))
      throw new Error(`Unknown project: ${project}`);
    if (mode === "pack") {
      if (!project || budget < packBudgetMin || budget > packBudgetMax)
        throw new Error(usage);
      process.stdout.write(
        `${JSON.stringify(
          presentSearchResult(
            buildTaskPack(sources, knowledge, {
              scope,
              projectId: project,
              question: query,
              budgetBytes: budget,
            }),
            undefined,
            env,
          ),
        )}\n`,
      );
      return;
    }
    const limit = values.k ? Number(values.k) : 8;
    const pack = presentSearchResult(
      buildContextPackage(
        sources,
        knowledge,
        contextPackageSchema.parse({
          scope,
          question: query,
          limit,
          ...(values.since ? { from: values.since } : {}),
          ...(values.until ? { until: values.until } : {}),
          ...(values.budget ? { maxBytes: budget } : {}),
        }),
        undefined,
        project,
      ),
      undefined,
      env,
    );
    process.stdout.write(`${JSON.stringify(pack)}\n`);
  } catch (error) {
    if (error instanceof ZodError) throw new Error(usage);
    throw error;
  } finally {
    knowledge.close();
    sources.close();
  }
}
