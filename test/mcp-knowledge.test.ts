import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("MCP grounds suggested knowledge, denies cross-scope references and exposes no approval tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-mcp-knowledge-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const scope = "knowledge";
  const { source } = sources.capture({
    version: 1,
    scope,
    text: "Synthetic paper observatory",
    origin: "fixture:knowledge",
    idempotencyKey: "source",
  });
  const foreign = sources.capture({
    version: 1,
    scope: "foreign",
    text: "Synthetic forbidden source",
    origin: "fixture:foreign",
    idempotencyKey: "foreign",
  }).source;
  const mcp = createContextMcp(sources, [scope], false, { knowledge });
  const client = new Client({ name: "knowledge-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  const input = {
    version: 1 as const,
    scope,
    idempotencyKey: "idea",
    kind: "idea" as const,
    text: "A paper observatory",
    sourceRefs: [{ sourceId: source.id, quote: "paper observatory" }],
    creator: { kind: "user" as const, name: "Untrusted author claim" },
  };
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(
      names.some((name) => /approve|review/.test(name)),
      false,
    );
    assert.throws(() =>
      knowledge.add({
        ...input,
        sourceRefs: [{ sourceId: foreign.id }],
      }),
    );
    const saved = knowledge.add(input);
    assert.equal(saved.item.status, "suggested");
    for (const name of ["add_knowledge", "read_knowledge"]) {
      const hidden = await client.callTool({
        name,
        arguments: { version: 1, scope, id: saved.item.id },
      });
      assert.equal(hidden.isError, true, name);
      assert.equal(
        z.object({ error: z.string() }).parse(hidden.structuredContent).error,
        "unknown_tool",
      );
      assert.equal(JSON.stringify(hidden).includes(foreign.text), false);
    }
    const recalled = await client.callTool({
      name: "read",
      arguments: { scope, id: saved.item.id },
    });
    assert.ok(!recalled.isError, JSON.stringify(recalled));
    assert.equal(knowledge.list(scope).length, 1);
  } finally {
    await client.close();
    await mcp.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
