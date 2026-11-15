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
import { JobStore } from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("MCP queues only authorized persisted sources and returns status without worker credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-mcp-processing-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path),
    knowledge = new KnowledgeStore(path),
    jobs = new JobStore(path);
  const scope = "processing";
  const { source } = sources.capture({
    version: 1,
    scope,
    text: "Synthetic paper observatory",
    origin: "fixture:processing",
    idempotencyKey: "source",
  });
  const mcp = createContextMcp(sources, [scope], false, { knowledge, jobs });
  const client = new Client({ name: "processing-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  const input = {
    version: 1 as const,
    scope,
    sourceId: source.id,
    idempotencyKey: "job",
  };
  try {
    for (const hiddenName of ["queue_processing", "processing_status"]) {
      const hidden = await client.callTool({
        name: hiddenName,
        arguments: { ...input, version: 1 },
      });
      assert.equal(hidden.isError, true, hiddenName);
      assert.equal(
        z.object({ error: z.string() }).parse(hidden.structuredContent).error,
        "unknown_tool",
      );
      assert.equal(JSON.stringify(hidden).includes("leaseToken"), false);
    }
    const queued = jobs.enqueue(input);
    const claimed = jobs.claim(scope);
    assert.ok(claimed);
    assert.equal(JSON.stringify(queued).includes(claimed.leaseToken), false);
    assert.equal(jobs.list(scope).length, 1);
  } finally {
    await client.close();
    await mcp.close();
    jobs.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
