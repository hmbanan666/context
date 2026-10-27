import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { startService } from "../src/server.js";

function payload(result: { structuredContent?: unknown }) {
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

const scope = "synthetic:local-foundation";
const capture = {
  version: 1,
  scope,
  text: "Synthetic cobalt fox jumps.\nЮникод 🦊",
  origin: "test:mcp-client",
  idempotencyKey: "mcp-001",
};
const sourceSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  origin: z.string(),
  scope: z.string(),
  capturedAt: z.iso.datetime(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal("unreviewed"),
});

async function connect(url: string) {
  const client = new Client({
    name: "context-integration-test",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`)),
  );
  return client;
}

test("MCP client captures, retries, searches and recalls an unchanged source after restart", {
  timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-mcp-"));
  const config = {
    port: 0,
    databasePath: join(directory, "context.db"),
    localMcpScopes: [scope],
  };
  let service = await startService(config);
  let client: Client | undefined;
  try {
    client = await connect(`http://127.0.0.1:${service.address.port}`);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "capture",
      "recall",
    ]);
    const saved = await client.callTool({
      name: "capture",
      arguments: capture,
    });
    assert.ok(!saved.isError);
    const source = sourceSchema.parse(payload(saved).source);
    assert.equal(source.text, capture.text);
    assert.equal(source.origin, capture.origin);
    assert.equal(source.scope, scope);
    assert.equal(
      source.checksum,
      "12d9e9edd65c2213a088a61dfcffa9080327c690ef222fab3579721311a6330f",
    );
    const duplicate = await client.callTool({
      name: "capture",
      arguments: capture,
    });
    assert.equal(payload(duplicate).duplicate, true);
    assert.deepEqual(payload(duplicate).source, source);
    const conflict = await client.callTool({
      name: "capture",
      arguments: { ...capture, text: "different" },
    });
    assert.equal(conflict.isError, true);
    assert.equal(payload(conflict).error, "idempotency_conflict");
    const results = await client.callTool({
      name: "recall",
      arguments: { version: 1, scope, query: "cobalt fox" },
    });
    assert.deepEqual(payload(results).sources, [source]);
    await client.close();
    client = undefined;
    await service.close();
    service = await startService(config);
    client = await connect(`http://127.0.0.1:${service.address.port}`);
    const recalled = await client.callTool({
      name: "recall",
      arguments: { version: 1, scope, id: source.id },
    });
    assert.deepEqual(payload(recalled).sources, [source]);
    const retry = await client.callTool({
      name: "capture",
      arguments: capture,
    });
    assert.equal(payload(retry).duplicate, true);
    assert.deepEqual(payload(retry).source, source);
    const searched = await client.callTool({
      name: "recall",
      arguments: { version: 1, scope, query: "Юникод" },
    });
    assert.deepEqual(payload(searched).sources, [source]);
  } finally {
    await client?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scope grants come from server configuration and cannot be supplied by a client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-scope-"));
  const databasePath = join(directory, "context.db");
  const writer = await startService({
    port: 0,
    databasePath,
    localMcpScopes: [scope],
  });
  const reader = await startService({
    port: 0,
    databasePath,
    localMcpScopes: ["synthetic:other"],
  });
  const a = await connect(`http://127.0.0.1:${writer.address.port}`);
  const b = await connect(`http://127.0.0.1:${reader.address.port}`);
  try {
    const saved = await a.callTool({ name: "capture", arguments: capture });
    const source = sourceSchema.parse(payload(saved).source);
    for (const arguments_ of [
      { version: 1, scope, id: source.id },
      { version: 1, scope, query: "cobalt" },
    ]) {
      const denied = await b.callTool({
        name: "recall",
        arguments: arguments_,
      });
      assert.equal(denied.isError, true);
      assert.equal(payload(denied).error, "forbidden_scope");
      assert.equal(JSON.stringify(denied).includes(capture.text), false);
    }
    const deniedWrite = await b.callTool({
      name: "capture",
      arguments: capture,
    });
    assert.equal(payload(deniedWrite).error, "forbidden_scope");
    const crossScopeId = await b.callTool({
      name: "recall",
      arguments: { version: 1, scope: "synthetic:other", id: source.id },
    });
    assert.equal(payload(crossScopeId).error, "not_found");
    const crossScopeSearch = await b.callTool({
      name: "recall",
      arguments: { version: 1, scope: "synthetic:other", query: "cobalt" },
    });
    assert.deepEqual(payload(crossScopeSearch).sources, []);
    const other = await b.callTool({
      name: "capture",
      arguments: { ...capture, scope: "synthetic:other" },
    });
    const otherSource = sourceSchema.parse(payload(other).source);
    assert.notEqual(otherSource.id, source.id);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        a.callTool({
          name: "capture",
          arguments: { ...capture, idempotencyKey: "concurrent-001" },
        }),
      ),
    );
    const ids = concurrent.map(
      (item) => sourceSchema.parse(payload(item).source).id,
    );
    assert.equal(new Set(ids).size, 1);
    assert.equal(
      concurrent.filter((item) => payload(item).duplicate === false).length,
      1,
    );
  } finally {
    await a.close();
    await b.close();
    await writer.close();
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP validates inputs, rejects approval claims and treats search operators as literals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-validation-"));
  const service = await startService({
    port: 0,
    databasePath: join(directory, "context.db"),
    localMcpScopes: [scope],
  });
  const client = await connect(`http://127.0.0.1:${service.address.port}`);
  try {
    const invalidCaptures = [
      { ...capture, version: 2 },
      { ...capture, text: "" },
      { ...capture, text: "x".repeat(8193) },
      { ...capture, text: "Synthetic\ud800text" },
      { ...capture, origin: "fixture:\udc00" },
      { ...capture, text: "\u0000Synthetic text" },
      { ...capture, origin: "fixture:\u0000test" },
      { ...capture, origin: " " },
      { ...capture, scope: "private:notes" },
      { ...capture, idempotencyKey: "" },
      { ...capture, status: "approved" },
      { ...capture, grantedScopes: [scope] },
    ];
    for (const input of invalidCaptures) {
      const result = await client.callTool({
        name: "capture",
        arguments: input,
      });
      assert.equal(result.isError, true);
    }
    for (const input of [
      { version: 1, scope },
      { version: 1, scope, id: "a", query: "fox" },
      { version: 1, scope, query: "fox", limit: 21 },
      { version: 1, scope, query: "fox", limit: 0 },
    ]) {
      const result = await client.callTool({
        name: "recall",
        arguments: input,
      });
      assert.equal(result.isError, true);
    }
    const valid = await client.callTool({
      name: "capture",
      arguments: capture,
    });
    assert.equal(payload(valid).duplicate, false);
    const noOperators = await client.callTool({
      name: "recall",
      arguments: { version: 1, scope, query: '" OR fox* --' },
    });
    assert.ok(!noOperators.isError);
    assert.deepEqual(payload(noOperators).sources, []);
  } finally {
    await client.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP rejects browser/DNS rebinding, invalid authorization and oversized requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-mcp-http-"));
  const service = await startService({
    port: 0,
    databasePath: join(directory, "context.db"),
    localMcpScopes: [scope],
  });
  const url = `http://127.0.0.1:${service.address.port}/mcp`;
  try {
    for (const headers of [
      { Host: "attacker.example" },
      { Origin: "https://attacker.example" },
      { Origin: "null" },
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request(
          url,
          { method: "POST", headers },
          (incoming) => {
            incoming.resume();
            resolve(incoming.statusCode ?? 0);
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.equal(status, 403);
    }
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { Authorization: "Bearer invalid" },
        })
      ).status,
      401,
    );
    const oversized = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(65537),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
