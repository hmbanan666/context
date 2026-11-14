import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { scopeSchema } from "./contracts.js";
import { SourceStore } from "./store.js";

const usage =
  "Usage: context project create --id <id> --name <name> --home <area> | rename --id <id> --name <name> | list | map --repo <owner/repo> --project <id> | unmap --repo <owner/repo> | backfill";

function flags(
  args: string[],
  options: Record<string, { type: "string" }>,
): Record<string, string | undefined> {
  try {
    return parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new Error(usage);
  }
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
function databasePath(env: NodeJS.ProcessEnv): string {
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  return path;
}
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function projectCommand(args: string[], env: NodeJS.ProcessEnv): void {
  try {
    const action = args[0];
    const rest = args.slice(1);
    if (
      !action ||
      !["create", "rename", "list", "map", "unmap", "backfill"].includes(action)
    )
      throw new Error(usage);
    const configured = areas(env);
    const run = (store: SourceStore) => {
      if (action === "create") {
        const values = flags(rest, {
          id: { type: "string" },
          name: { type: "string" },
          home: { type: "string" },
        });
        if (!values.id || !values.name || !values.home) throw new Error(usage);
        if (!configured.includes(values.home)) throw new Error("Unknown area");
        emit(
          store.createProject({
            id: values.id,
            name: values.name,
            homeArea: values.home,
          }),
        );
        return;
      }
      if (action === "rename") {
        const values = flags(rest, {
          id: { type: "string" },
          name: { type: "string" },
        });
        if (!values.id || !values.name) throw new Error(usage);
        emit(store.renameProject(values.id, values.name));
        return;
      }
      if (action === "list") {
        if (rest.length) throw new Error(usage);
        emit({
          projects: store.listProjects().projects,
          mappings: store.repositoryMappings(),
        });
        return;
      }
      if (action === "map") {
        const values = flags(rest, {
          repo: { type: "string" },
          project: { type: "string" },
        });
        if (!values.repo || !values.project) throw new Error(usage);
        emit(store.mapRepository(values.repo, values.project));
        return;
      }
      if (action === "unmap") {
        const values = flags(rest, { repo: { type: "string" } });
        if (!values.repo) throw new Error(usage);
        store.unmapRepository(values.repo);
        emit({ repo: values.repo, mapped: false });
        return;
      }
      if (action === "backfill") {
        if (rest.length) throw new Error(usage);
        emit(store.backfillProjects());
        return;
      }
      throw new Error(usage);
    };
    const store = new SourceStore(databasePath(env));
    try {
      run(store);
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof ZodError) throw new Error("Invalid project arguments");
    throw error;
  }
}
