export interface Config {
  readonly port: number;
  readonly databasePath: string;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  // Until remote authentication exists, every deployed mode must fail closed.
  if (env.NODE_ENV && !["development", "test"].includes(env.NODE_ENV)) {
    throw new Error("Only local development and test modes are supported");
  }
  const port = env.CONTEXT_PORT ?? "3000";
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("CONTEXT_PORT must be an integer between 0 and 65535");
  }
  const databasePath = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!databasePath.trim() || databasePath === ":memory:") {
    throw new Error("CONTEXT_DB_PATH must name a persistent SQLite file");
  }
  return { port: Number(port), databasePath };
}
