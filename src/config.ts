import { type ClientGrants, clientGrantsSchema } from "./access.js";
import type { OAuthConfig } from "./auth.js";
import { scopeSchema } from "./contracts.js";

export interface Config {
  readonly port: number;
  readonly databasePath: string;
  readonly localMcpScopes?: readonly string[];
  readonly oauth?: OAuthConfig;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  // Production requires the complete protected pilot configuration.
  if (
    env.NODE_ENV &&
    !["development", "test", "production"].includes(env.NODE_ENV)
  ) {
    throw new Error("Unsupported runtime mode");
  }
  const port = env.CONTEXT_PORT ?? "3000";
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("CONTEXT_PORT must be an integer between 0 and 65535");
  }
  const databasePath = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!databasePath.trim() || databasePath === ":memory:") {
    throw new Error("CONTEXT_DB_PATH must name a persistent SQLite file");
  }
  if (env.CONTEXT_AUTH === "oauth") {
    if (
      env.CONTEXT_LOCAL_MCP !== undefined ||
      env.CONTEXT_LOCAL_SCOPES !== undefined
    ) {
      throw new Error("OAuth and local no-auth modes cannot be combined");
    }
    let clientGrants: ClientGrants | undefined;
    if (env.CONTEXT_CLIENT_GRANTS !== undefined) {
      if (Buffer.byteLength(env.CONTEXT_CLIENT_GRANTS, "utf8") > 16384)
        throw new Error("Client grant configuration is too large");
      clientGrants = clientGrantsSchema.parse(
        JSON.parse(env.CONTEXT_CLIENT_GRANTS),
      );
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
        ...(clientGrants === undefined ? {} : { clientGrants }),
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
