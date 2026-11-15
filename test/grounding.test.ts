import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  assessGrounding,
  bestCosine,
  readGroundingThresholds,
} from "../src/grounding.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("grounding uses absolute term overlap and cosine, not rank", () => {
  const thresholds = readGroundingThresholds({});
  assert.equal(
    assessGrounding({
      contentTerms: 2,
      matchedTerms: 2,
      cosine: 0,
      thresholds,
    }),
    "strong",
  );
  assert.equal(
    assessGrounding({
      contentTerms: 4,
      matchedTerms: 1,
      cosine: 0.8,
      thresholds,
    }),
    "weak",
  );
  assert.equal(
    assessGrounding({
      contentTerms: 3,
      matchedTerms: 0,
      cosine: 0.8,
      thresholds,
    }),
    "none",
  );
  assert.equal(
    assessGrounding({
      contentTerms: 3,
      matchedTerms: 0,
      cosine: 0.87,
      thresholds,
    }),
    "weak",
  );
  assert.equal(
    assessGrounding({
      contentTerms: 3,
      matchedTerms: 0,
      cosine: 0.93,
      thresholds,
    }),
    "strong",
  );
  assert.equal(bestCosine([{ score: 0.5 }, {}, { score: 0.91 }]), 0.91);
  assert.throws(() =>
    readGroundingThresholds({ CONTEXT_GROUNDING_COSINE_WEAK: "1.2" }),
  );
  assert.throws(() =>
    readGroundingThresholds({
      CONTEXT_GROUNDING_COSINE_WEAK: "0.95",
      CONTEXT_GROUNDING_COSINE_STRONG: "0.9",
    }),
  );
});

test("search tells the agent when nothing relevant was stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-"));
  const databasePath = join(directory, "context.db");
  const sources = new SourceStore(databasePath);
  const knowledge = new KnowledgeStore(databasePath);
  const mcp = createContextMcp(sources, ["personal"], false, { knowledge });
  const client = new Client({ name: "grounding-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  try {
    const listed = await client.listTools();
    const search = listed.tools.find((tool) => tool.name === "search");
    assert.match(search?.description ?? "", /grounding/);
    assert.match(search?.description ?? "", /don't know/);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "read",
      "remember",
      "search",
      "timeline",
    ]);
    const saved = await client.callTool({
      name: "remember",
      arguments: {
        text: "The cobalt lantern is in the blue cabinet.",
        idempotencyKey: "lantern",
        scope: "personal",
      },
    });
    assert.equal(saved.isError, false);
    const hit = await client.callTool({
      name: "search",
      arguments: { scope: "personal", query: "cobalt lantern" },
    });
    assert.equal(hit.isError, false);
    assert.equal(
      (hit.structuredContent as { grounding?: string }).grounding,
      "strong",
    );
    const miss = await client.callTool({
      name: "search",
      arguments: { scope: "personal", query: "weather in Kazan tomorrow" },
    });
    assert.equal(miss.isError, false);
    assert.equal(
      (miss.structuredContent as { grounding?: string }).grounding,
      "none",
    );
  } finally {
    await client.close();
    await mcp.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
