import { scopeSchema } from "./contracts.js";

export interface Config {
  readonly port: number;
  readonly databasePath: string;
  readonly localMcpScopes?: readonly string[];
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
  const mode = env.CONTEXT_LOCAL_MCP;
  if (mode === undefined && env.CONTEXT_LOCAL_SCOPES === undefined) {
    return { port: Number(port), databasePath };
  }
  if (mode !== "synthetic") {
    throw new Error("CONTEXT_LOCAL_MCP must explicitly be synthetic");
  }
  const scopes = (
    env.CONTEXT_LOCAL_SCOPES ?? "synthetic:local-foundation"
  ).split(",");
  if (scopes.length > 8 || new Set(scopes).size !== scopes.length) {
    throw new Error("Configure 1–8 distinct synthetic scopes");
  }
  for (const scope of scopes) scopeSchema.parse(scope);
  return { port: Number(port), databasePath, localMcpScopes: scopes };
}
