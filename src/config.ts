import {
  type ClientGrants,
  clientGrantsSchema,
  configuredDataScopes,
} from "./access.js";
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
    env.CONTEXT_PERSONAL_MEMORY !== undefined
  ) {
    throw new Error(
      "Use CONTEXT_AREAS and explicit client grants instead of legacy mode settings",
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
    if (
      env.CONTEXT_CLIENT_GRANTS === undefined ||
      Buffer.byteLength(env.CONTEXT_CLIENT_GRANTS, "utf8") > 16384
    ) {
      throw new Error("Configure explicit client grants (at most 16384 bytes)");
    }
    const clientGrants: ClientGrants = clientGrantsSchema.parse(
      JSON.parse(env.CONTEXT_CLIENT_GRANTS),
    );
    if (
      configuredDataScopes(clientGrants).some((area) => !areas.includes(area))
    ) {
      throw new Error("Client grants must name configured areas");
    }
    if (
      env.CONTEXT_PUBLIC_URL !== "https://context.kosarev.space/mcp" ||
      env.CONTEXT_OAUTH_ISSUER !==
        "https://context.kosarev.space/auth/realms/context" ||
      !env.CONTEXT_OWNER_SUBJECT?.trim()
    ) {
      throw new Error(
        "Configure the approved HTTPS resource, issuer and owner subject",
      );
    }
    return {
      port: Number(port),
      databasePath,
      oauth: {
        resource: env.CONTEXT_PUBLIC_URL,
        issuer: env.CONTEXT_OAUTH_ISSUER,
        ownerSubject: env.CONTEXT_OWNER_SUBJECT,
        clientGrants,
      },
    };
  }
  if (
    env.NODE_ENV === "production" ||
    env.CONTEXT_AUTH !== undefined ||
    env.CONTEXT_PUBLIC_URL !== undefined ||
    env.CONTEXT_OAUTH_ISSUER !== undefined ||
    env.CONTEXT_OWNER_SUBJECT !== undefined ||
    env.CONTEXT_CLIENT_GRANTS !== undefined
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
