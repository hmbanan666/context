import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { scopeSchema } from "./contracts.js";
import { SourceStore } from "./store.js";

const usage =
  "Usage: context project create --id <id> --name <name> --home <area> | rename --id <id> --name <name> | list | map --repo <owner/repo> --project <id> | unmap --repo <owner/repo> | backfill | profile show --id <id> | profile set --id <id> --purpose <text> --rules <text> [--pin <decision-id> ...] | profile clear --id <id>";

function text(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function flags(
  args: string[],
  options: Record<string, { type: "string"; multiple?: boolean }>,
): Record<string, string | string[] | undefined> {
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
      ![
        "create",
        "rename",
        "list",
        "map",
        "unmap",
        "backfill",
        "profile",
      ].includes(action)
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
        const id = text(values.id);
        const name = text(values.name);
        const home = text(values.home);
        if (!id || !name || !home) throw new Error(usage);
        if (!configured.includes(home)) throw new Error("Unknown area");
        emit(store.createProject({ id, name, homeArea: home }));
        return;
      }
      if (action === "rename") {
        const values = flags(rest, {
          id: { type: "string" },
          name: { type: "string" },
        });
        const id = text(values.id);
        const name = text(values.name);
        if (!id || !name) throw new Error(usage);
        emit(store.renameProject(id, name));
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
        const repo = text(values.repo);
        const project = text(values.project);
        if (!repo || !project) throw new Error(usage);
        emit(store.mapRepository(repo, project));
        return;
      }
      if (action === "unmap") {
        const values = flags(rest, { repo: { type: "string" } });
        const repo = text(values.repo);
        if (!repo) throw new Error(usage);
        store.unmapRepository(repo);
        emit({ repo, mapped: false });
        return;
      }
      if (action === "backfill") {
        if (rest.length) throw new Error(usage);
        emit(store.backfillProjects());
        return;
      }
      if (action === "profile") {
        const which = rest[0];
        const profileArgs = rest.slice(1);
        if (which === "show" || which === "clear") {
          const values = flags(profileArgs, { id: { type: "string" } });
          const id = values.id;
          if (typeof id !== "string") throw new Error(usage);
          if (which === "clear") {
            store.clearProfile(id);
            emit({ profile: null });
            return;
          }
          emit({ profile: store.profile(id) ?? null });
          return;
        }
        if (which === "set") {
          const values = flags(profileArgs, {
            id: { type: "string" },
            purpose: { type: "string" },
            rules: { type: "string" },
            pin: { type: "string", multiple: true },
          });
          const id = values.id;
          const purpose = values.purpose;
          const rules = values.rules;
          const pinned = values.pin;
          if (
            typeof id !== "string" ||
            typeof purpose !== "string" ||
            typeof rules !== "string" ||
            (pinned !== undefined && !Array.isArray(pinned))
          )
            throw new Error(usage);
          emit(
            store.setProfile({
              projectId: id,
              purpose,
              rules,
              ...(pinned ? { pinned } : {}),
            }),
          );
          return;
        }
        throw new Error(usage);
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
