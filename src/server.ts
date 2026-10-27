import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";
import { SourceStore } from "./store.js";

export async function startService(config: Config) {
  const store = new SourceStore(config.databasePath);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
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
        store.close();
      }
    },
  };
}
