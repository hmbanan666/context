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
  if (
    env.CONTEXT_LOCAL_SCOPES !== undefined ||
    env.CONTEXT_PERSONAL_MEMORY !== undefined ||
    env.CONTEXT_OAUTH_ISSUER !== undefined ||
    env.CONTEXT_OWNER_SUBJECT !== undefined ||
    env.CONTEXT_CLIENT_GRANTS !== undefined
  ) {
    throw new Error(
      "Remove legacy auth settings; use built-in auth and the client registry",
    );
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
  if (env.CONTEXT_AUTH === "oauth") {
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
    const boundedSeconds = (
      name: string,
      fallback: number,
      maximum: number,
    ) => {
      const value = env[name] ?? String(fallback);
      if (
        !/^\d+$/.test(value) ||
        Number(value) < 300 ||
        Number(value) > maximum
      )
        throw new Error("Invalid refresh lifetime");
      return Number(value);
    };
    const refreshSeconds = boundedSeconds(
      "CONTEXT_REFRESH_SECONDS",
      86400,
      30 * 86400,
    );
    const offlineSeconds = boundedSeconds(
      "CONTEXT_OFFLINE_SECONDS",
      30 * 86400,
      365 * 86400,
    );
    if (offlineSeconds < refreshSeconds)
      throw new Error("Offline lifetime must cover refresh idle lifetime");
    return {
      port: Number(port),
      databasePath,
      oauth: {
        resource: resource.href,
        issuer: resource.origin,
        areas,
        refreshSeconds,
        offlineSeconds,
      },
    };
  }
  if (
    env.NODE_ENV === "production" ||
    env.CONTEXT_AUTH !== undefined ||
    env.CONTEXT_PUBLIC_URL !== undefined ||
    env.CONTEXT_OAUTH_ISSUER !== undefined ||
    env.CONTEXT_OWNER_SUBJECT !== undefined ||
    env.CONTEXT_CLIENT_GRANTS !== undefined ||
    env.CONTEXT_REFRESH_SECONDS !== undefined ||
    env.CONTEXT_OFFLINE_SECONDS !== undefined
  ) {
    throw new Error("Protected configuration requires CONTEXT_AUTH=oauth");
  }
  const mode = env.CONTEXT_LOCAL_MCP;
  if (mode === undefined) return { port: Number(port), databasePath };
  if (mode !== "enabled") {
    throw new Error("CONTEXT_LOCAL_MCP must explicitly be enabled");
  }
  return { port: Number(port), databasePath, localMcpScopes: areas };
}
