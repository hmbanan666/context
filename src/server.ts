import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  localhostHostValidation,
  localhostOriginValidation,
  type NodeIncomingMessageLike,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { Config } from "./config.js";
import { createContextMcp } from "./mcp.js";
import { SourceStore } from "./store.js";

export async function startService(config: Config) {
  const store = new SourceStore(config.databasePath);
  const mcp = config.localMcpScopes
    ? createContextMcp(store, config.localMcpScopes)
    : undefined;
  const handleMcp = mcp
    ? toNodeHandler(mcp, { maxRequestBodySize: 65536 })
    : undefined;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/mcp" && handleMcp) {
      if (
        !validateHost(request, response) ||
        !validateOrigin(request, response)
      )
        return;
      if (request.headers.authorization !== undefined) {
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
      server.listen(config.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await mcp?.close();
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
        store.close();
      }
    },
  };
}
