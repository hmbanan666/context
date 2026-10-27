import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  const scope = "synthetic:knowledge";
  const { source } = sources.capture({
    version: 1,
    scope,
    text: "Synthetic paper observatory",
    origin: "fixture:knowledge",
    idempotencyKey: "source",
  });
  const foreign = sources.capture({
    version: 1,
    scope: "synthetic:foreign",
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
    version: 1,
    scope,
    idempotencyKey: "idea",
    kind: "idea",
    text: "A paper observatory",
    sourceRefs: [{ sourceId: source.id, quote: "paper observatory" }],
    creator: { kind: "user", name: "Untrusted author claim" },
  };
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(
      names.some((name) => /approve|review/.test(name)),
      false,
    );
    const invalid = await client.callTool({
      name: "add_knowledge",
      arguments: { ...input, status: "approved" },
    });
    assert.equal(invalid.isError, true);
    const crossScope = await client.callTool({
      name: "add_knowledge",
      arguments: { ...input, sourceRefs: [{ sourceId: foreign.id }] },
    });
    assert.equal(crossScope.isError, true);
    assert.equal(JSON.stringify(crossScope).includes(foreign.text), false);
    const saved = await client.callTool({
      name: "add_knowledge",
      arguments: input,
    });
    assert.ok(!saved.isError);
    const { item } = z
      .object({
        item: z.object({ id: z.string(), status: z.literal("suggested") }),
      })
      .parse(saved.structuredContent);
    const denied = await client.callTool({
      name: "read_knowledge",
      arguments: { version: 1, scope: foreign.scope, id: item.id },
    });
    assert.equal(denied.isError, true);
    const recalled = await client.callTool({
      name: "read_knowledge",
      arguments: { version: 1, scope, id: item.id },
    });
    assert.ok(!recalled.isError);
    assert.equal(knowledge.list(scope).length, 1);
  } finally {
    await client.close();
    await mcp.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
