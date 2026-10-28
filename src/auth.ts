import {
  type McpHttpHandler,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import {
  type ClientGrants,
  configuredDataScopes,
  operationScopes,
  pilotDataScope,
} from "./access.js";

export interface OAuthConfig {
  readonly issuer: string;
  readonly resource: string;
  readonly ownerSubject: string;
  readonly clientGrants?: ClientGrants;
  readonly personalMemory?: boolean;
}

export function protectMcp(
  handler: Pick<McpHttpHandler, "fetch">,
  config: OAuthConfig,
  resolveKey?: JWTVerifyGetKey,
) {
  const gate = requireBearerAuth({
    verifier: createTokenVerifier(config, resolveKey),
    expectedResource: new URL(config.resource),
    resourceMetadataUrl: `${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp`,
  });
  const budgets = new Map<string, { start: number; count: number }>();
  return {
    async fetch(request: Request) {
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      const now = Date.now();
      let budget = budgets.get(auth.clientId);
      if (!budget || now - budget.start >= 60000) {
        budget = { start: now, count: 0 };
        budgets.set(auth.clientId, budget);
      }
      if (++budget.count > 60)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      return handler.fetch(request, { authInfo: auth });
    },
  };
}

export const pilotScope = pilotDataScope;
export const oauthScopes = ["context:read", "context:write", pilotScope];

export function createTokenVerifier(
  config: OAuthConfig,
  resolveKey?: JWTVerifyGetKey,
): OAuthTokenVerifier {
  const recognizedScopes = new Set<string>([
    ...operationScopes,
    ...configuredDataScopes(config.clientGrants),
  ]);
  const keys =
    resolveKey ??
    createRemoteJWKSet(
      new URL(`${config.issuer}/protocol/openid-connect/certs`),
      { timeoutDuration: 5000 },
    );
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: config.issuer,
          audience: config.resource,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat", "azp", "scope"],
          maxTokenAge: "5m",
        });
        if (
          payload.sub !== config.ownerSubject ||
          typeof payload.exp !== "number" ||
          typeof payload.iat !== "number" ||
          payload.exp - payload.iat > 300 ||
          typeof payload.azp !== "string" ||
          !["context-chatgpt", "context-codex"].includes(payload.azp) ||
          typeof payload.scope !== "string"
        )
          throw new Error("Invalid claims");
        return {
          token,
          clientId: payload.azp,
          scopes: payload.scope
            .split(" ")
            .filter((scope) => recognizedScopes.has(scope)),
          expiresAt: payload.exp,
          resource: new URL(config.resource),
        };
      } catch {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Invalid or expired Context access token",
        );
      }
    },
  };
}
