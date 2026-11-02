import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { protectMcp } from "./auth.js";
import { AuthStore } from "./auth-store.js";
import type { Config } from "./config.js";
import { EmbeddingIndex } from "./embedding-index.js";
import { type Embedder, localEmbedder } from "./embedding-model.js";
import { JobStore } from "./jobs.js";
import { KnowledgeStore } from "./knowledge.js";
import { createContextMcp } from "./mcp.js";
import { AuthorizationServer } from "./oauth.js";
import { SourceStore } from "./store.js";

export async function startService(
  config: Config,
  embedder: Embedder = localEmbedder(),
) {
  const store = new SourceStore(config.databasePath);
  let knowledge: KnowledgeStore;
  let jobs: JobStore;
  try {
    knowledge = new KnowledgeStore(config.databasePath);
    try {
      jobs = new JobStore(config.databasePath);
    } catch (error) {
      knowledge.close();
      throw error;
    }
  } catch (error) {
    store.close();
    throw error;
  }
  const embeddings = new EmbeddingIndex(config.databasePath, embedder);
  embeddings.backfill();
  embeddings.start();
  const auth = config.oauth
    ? new AuthStore(config.databasePath, config.oauth.areas)
    : undefined;
  const authorization =
    auth && config.oauth
      ? new AuthorizationServer(auth, config.oauth)
      : undefined;
  const handleAuth = authorization
    ? toNodeHandler(
        {
          fetch: (request: Request) =>
            authorization.fetch(
              new Request(
                new URL(
                  new URL(request.url).pathname + new URL(request.url).search,
                  config.oauth?.issuer,
                ),
                request,
              ),
            ),
        },
        { maxRequestBodySize: 16384 },
      )
    : undefined;
  const mcp =
    config.oauth || config.localMcpScopes
      ? createContextMcp(store, config.localMcpScopes ?? [], !!config.oauth, {
          knowledge,
          jobs,
          embeddings,
          ...(auth ? { auth } : {}),
        })
      : undefined;
  const authenticated =
    mcp && config.oauth && auth ? protectMcp(mcp, config.oauth, auth) : mcp;
  const handleMcp = mcp
    ? toNodeHandler(authenticated ?? mcp, { maxRequestBodySize: 65536 })
    : undefined;
  const validateHost = config.oauth
    ? hostHeaderValidation([new URL(config.oauth.resource).hostname])
    : localhostHostValidation();
  const validateOrigin = config.oauth
    ? originValidation([new URL(config.oauth.resource).hostname])
    : localhostOriginValidation();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const pathname = request.url?.split("?")[0] ?? "";
    if (
      handleAuth &&
      (pathname.startsWith("/.well-known/") ||
        pathname.startsWith("/oauth/") ||
        pathname.startsWith("/auth/"))
    ) {
      if (!validateHost(request, response)) return;
      // The canonical public origin is configured, never taken from forwarded headers.
      void handleAuth(request as NodeIncomingMessageLike, response).catch(
        () => {
          if (!response.headersSent) response.writeHead(400);
          response.end();
        },
      );
      return;
    }
    if (request.url === "/mcp" && handleMcp) {
      if (
        !validateHost(request, response) ||
        !validateOrigin(request, response)
      )
        return;
      if (!config.oauth && request.headers.authorization !== undefined) {
        response
          .writeHead(401)
          .end(JSON.stringify({ error: "local_development_mode_only" }));
        return;
      }
      // The SDK's structural optional fields omit Node's explicit undefined types.
      void handleMcp(request as NodeIncomingMessageLike, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
    if (request.url !== "/health") {
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      response
        .writeHead(405)
        .end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    try {
      store.checkHealth();
      response.writeHead(200).end(JSON.stringify({ status: "ok" }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ status: "unavailable" }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.oauth ? "0.0.0.0" : "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await mcp?.close();
    await embeddings.close();
    auth?.close();
    jobs.close();
    knowledge.close();
    store.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    address,
    embeddings,
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      } finally {
        await mcp?.close();
        await embeddings.close();
        auth?.close();
        jobs.close();
        knowledge.close();
        store.close();
      }
    },
  };
}
