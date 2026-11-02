import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startService } from "../src/server.js";

test("only health is exposed on loopback; private routes do not exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-http-"));
  const service = await startService({
    port: 0,
    databasePath: join(directory, "context.db"),
  });
  try {
    assert.equal(service.address.address, "127.0.0.1");
    const url = `http://127.0.0.1:${service.address.port}`;
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok" });
    const write = await fetch(`${url}/health`, { method: "POST" });
    assert.equal(write.status, 405);
    for (const path of ["/mcp", "/capture", "/recall", "/sources"]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${url}${path}`, { method });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "not_found" });
      }
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("built-in auth routes and CLI credentials work through the HTTP listener, including body limits and revocation", async () => {
  const { request } = await import("node:http");
  const { AuthStore } = await import("../src/auth-store.js");
  const { readConfig } = await import("../src/config.js");
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  const directory = await mkdtemp(join(process.cwd(), ".output-http-auth-"));
  const path = join(directory, "context.db");
  const config = readConfig({
    NODE_ENV: "production",
    CONTEXT_AUTH: "oauth",
    CONTEXT_PUBLIC_URL: "https://context.example/mcp",
    CONTEXT_DB_PATH: path,
    CONTEXT_PORT: "0",
    CONTEXT_AREAS: "personal,garden",
  });
  const service = await startService(config),
    registry = new AuthStore(path, ["personal", "garden"]);
  const raw = (
    path: string,
    method = "GET",
    body = "",
    headers: Record<string, string> = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: service.address.port,
          path,
          method,
          headers: { host: "context.example", ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const h = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                h.set(key, Array.isArray(value) ? value.join(",") : value);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
                headers: h,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  const client = new Client({ name: "fictional-http-client", version: "1" });
  try {
    const metadata = await raw("/.well-known/oauth-authorization-server");
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).issuer, "https://context.example");
    assert.equal(
      (await raw("/.well-known/oauth-protected-resource/mcp")).status,
      200,
    );
    assert.equal((await raw("/mcp", "POST")).status, 401);
    assert.equal(
      (
        await raw("/oauth/register", "POST", "{}", {
          host: "attacker.example",
          "content-type": "application/json",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await raw("/oauth/register", "POST", "x".repeat(17000), {
          "content-type": "application/json",
        })
      ).status,
      413,
    );
    const issued = registry.createCliToken(
      "fictional-http",
      { read: ["garden"], write: ["garden"], process: [] },
      "garden",
      86400,
      "https://context.example/mcp",
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("https://context.example/mcp"),
        {
          requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
          fetch: async (input, init) => {
            const r = new Request(input, init);
            return raw(
              new URL(r.url).pathname,
              r.method,
              await r.text(),
              Object.fromEntries(r.headers),
            );
          },
        },
      ),
    );
    assert.ok(
      !(
        await client.callTool({
          name: "remember",
          arguments: {
            text: "Fictional HTTP garden note",
            idempotencyKey: "http-note",
          },
        })
      ).isError,
    );
    assert.ok(
      !(
        await client.callTool({
          name: "memory_context",
          arguments: { scope: "garden" },
        })
      ).isError,
    );
    registry.revokeClient(issued.record.clientId);
    assert.equal(
      (
        await raw("/mcp", "POST", "", {
          authorization: `Bearer ${issued.token}`,
        })
      ).status,
      401,
    );
  } finally {
    await client.close();
    registry.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
