import { SourceStore } from "./store.js";

const usage =
  "Usage: context doc remove|restore <doc:project:type:key or source id>";

function databasePath(env: NodeJS.ProcessEnv): string {
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  return path;
}

export function docCommand(args: string[], env: NodeJS.ProcessEnv): void {
  const action = args[0];
  if (
    (action !== "remove" && action !== "restore") ||
    args.length !== 2 ||
    !args[1] ||
    args[1].startsWith("-")
  )
    throw new Error(usage);
  const store = new SourceStore(databasePath(env));
  try {
    const result =
      action === "restore"
        ? store.restoreRecord(args[1])
        : store.removeRecord(args[1]);
    if (!result) {
      process.stderr.write("Not found\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    store.close();
  }
}
