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
  const scope = "synthetic:processing";
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
    version: 1,
    scope,
    sourceId: source.id,
    idempotencyKey: "job",
  };
  try {
    const denied = await client.callTool({
      name: "queue_processing",
      arguments: { ...input, scope: "synthetic:other" },
    });
    assert.equal(denied.isError, true);
    const missing = await client.callTool({
      name: "queue_processing",
      arguments: { ...input, sourceId: "absent" },
    });
    assert.equal(missing.isError, true);
    const saved = await client.callTool({
      name: "queue_processing",
      arguments: input,
    });
    assert.ok(!saved.isError);
    const { job } = z
      .object({
        job: z.object({ id: z.string(), status: z.literal("queued") }),
      })
      .parse(saved.structuredContent);
    const claimed = jobs.claim(scope);
    assert.ok(claimed);
    const status = await client.callTool({
      name: "processing_status",
      arguments: { version: 1, scope, id: job.id },
    });
    assert.ok(!status.isError);
    assert.equal(JSON.stringify(status).includes(claimed.leaseToken), false);
    assert.equal(JSON.stringify(status).includes("leaseToken"), false);
    assert.equal(JSON.stringify(status).includes("output"), false);
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
