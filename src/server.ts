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
import { configuredDataScopes, operationScopes } from "./access.js";
import { oauthScopes, protectMcp } from "./auth.js";
import type { Config } from "./config.js";
import { JobStore } from "./jobs.js";
import { KnowledgeStore } from "./knowledge.js";
import { createContextMcp } from "./mcp.js";
import { SourceStore } from "./store.js";
import { WorkStore } from "./work.js";

export async function startService(config: Config) {
  const store = new SourceStore(config.databasePath);
  let knowledge: KnowledgeStore;
  let jobs: JobStore;
  let work: WorkStore;
  try {
    knowledge = new KnowledgeStore(config.databasePath);
    try {
      jobs = new JobStore(config.databasePath);
      try {
        work = new WorkStore(config.databasePath, store, knowledge);
      } catch (error) {
        jobs.close();
        throw error;
      }
    } catch (error) {
      knowledge.close();
      throw error;
    }
  } catch (error) {
    store.close();
    throw error;
  }
  const mcp =
    config.oauth || config.localMcpScopes
      ? createContextMcp(store, config.localMcpScopes ?? [], !!config.oauth, {
          knowledge,
          jobs,
          work,
          ...(config.oauth?.clientGrants === undefined
            ? {}
            : { clientGrants: config.oauth.clientGrants }),
        })
      : undefined;
  const authenticated =
    mcp && config.oauth ? protectMcp(mcp, config.oauth) : mcp;
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
    if (
      config.oauth &&
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(request.url ?? "")
    ) {
      if (!validateHost(request, response)) return;
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      response.writeHead(200).end(
        JSON.stringify({
          resource: config.oauth.resource,
          authorization_servers: [config.oauth.issuer],
          // Refresh consent is advertised separately from data-access grants.
          scopes_supported: [
            ...(config.oauth.clientGrants === undefined
              ? oauthScopes
              : [
                  ...operationScopes,
                  ...configuredDataScopes(config.oauth.clientGrants),
                ]),
            "offline_access",
          ],
          bearer_methods_supported: ["header"],
          resource_name: "Context synthetic pilot",
        }),
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
          .end(JSON.stringify({ error: "local_synthetic_mode_only" }));
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
    work.close();
    jobs.close();
    knowledge.close();
    store.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    address,
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      } finally {
        await mcp?.close();
        work.close();
        jobs.close();
        knowledge.close();
        store.close();
      }
    },
  };
}
