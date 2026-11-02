import {
  type McpHttpHandler,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { AuthStore } from "./auth-store.js";
import type { OAuthConfig } from "./oauth.js";

export type { OAuthConfig } from "./oauth.js";

export function protectMcp(
  handler: Pick<McpHttpHandler, "fetch">,
  config: OAuthConfig,
  registry: AuthStore,
) {
  const gate = requireBearerAuth({
    verifier: createTokenVerifier(config, registry),
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

export function createTokenVerifier(
  config: OAuthConfig,
  registry: AuthStore,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      try {
        const access = registry.access(token, config.resource);
        return {
          token,
          clientId: access.clientId,
          scopes: access.scopes,
          expiresAt: access.expires,
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
