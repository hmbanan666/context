import type { OAuthConfig } from "./auth.js";
import { personalDataScope, scopeSchema } from "./contracts.js";

export interface Config {
  readonly port: number;
  readonly databasePath: string;
  readonly localMcpScopes?: readonly string[];
  readonly oauth?: OAuthConfig;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  // Production requires complete protected configuration.
  if (
    env.NODE_ENV &&
    !["development", "test", "production"].includes(env.NODE_ENV)
  ) {
    throw new Error("Unsupported runtime mode");
  }
  const areas = (env.CONTEXT_AREAS ?? personalDataScope).split(",");
  if (areas.length > 8 || new Set(areas).size !== areas.length) {
    throw new Error("Configure 1–8 distinct areas");
  }
  for (const area of areas) scopeSchema.parse(area);
  const port = env.CONTEXT_PORT ?? "3000";
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("CONTEXT_PORT must be an integer between 0 and 65535");
  }
  const databasePath = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!databasePath.trim() || databasePath === ":memory:") {
    throw new Error("CONTEXT_DB_PATH must name a persistent SQLite file");
  }
  // Keep the old explicit selector accepted for existing installations.
  if (env.CONTEXT_AUTH !== undefined && env.CONTEXT_AUTH !== "oauth")
    throw new Error("Only built-in OAuth is supported");
  if (env.CONTEXT_PUBLIC_URL !== undefined || env.CONTEXT_AUTH === "oauth") {
    if (env.CONTEXT_LOCAL_MCP !== undefined) {
      throw new Error("OAuth and local no-auth modes cannot be combined");
    }
    const resource = new URL(env.CONTEXT_PUBLIC_URL ?? "");
    if (
      resource.protocol !== "https:" ||
      resource.username ||
      resource.password ||
      resource.search ||
      resource.hash ||
      resource.pathname !== "/mcp"
    ) {
      throw new Error("Configure an HTTPS MCP resource ending in /mcp");
    }
    return {
      port: Number(port),
      databasePath,
      oauth: {
        resource: resource.href,
        issuer: resource.origin,
        areas,
        refreshSeconds: 86400,
        offlineSeconds: 30 * 86400,
      },
    };
  }
  if (env.NODE_ENV === "production")
    throw new Error("Configure CONTEXT_PUBLIC_URL for protected access");
  const mode = env.CONTEXT_LOCAL_MCP;
  if (mode === undefined) return { port: Number(port), databasePath };
  if (mode !== "enabled") {
    throw new Error("CONTEXT_LOCAL_MCP must explicitly be enabled");
  }
  return { port: Number(port), databasePath, localMcpScopes: areas };
}
