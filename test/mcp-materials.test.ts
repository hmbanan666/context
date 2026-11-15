import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("MCP preserves file bytes and metadata and denies material access outside grants", async () => {
  const store = new SourceStore(":memory:");
  const mcp = createContextMcp(store, ["materials"]);
  const client = new Client({ name: "materials-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  const args = {
    version: 1,
    scope: "materials",
    origin: "fixture:materials",
    idempotencyKey: "file-001",
    filename: "idea.txt",
    mediaType: "text/plain",
    contentBase64: "U3ludGhldGljIGdyZWVuIGtpdGUuDQo=",
    metadata: { title: "Synthetic idea" },
  };
  try {
    const saved = await client.callTool({
      name: "remember",
      arguments: {
        version: 1,
        scope: args.scope,
        idempotencyKey: args.idempotencyKey,
        metadata: args.metadata,
        file: {
          filename: args.filename,
          mediaType: args.mediaType,
          contentBase64: args.contentBase64,
        },
      },
    });
    assert.ok(!saved.isError, JSON.stringify(saved));
    const { material } = z
      .object({
        material: z.object({
          source: z.object({ id: z.string(), text: z.string() }),
          metadata: z.object({ title: z.string() }),
        }),
      })
      .parse(saved.structuredContent);
    assert.equal(material.source.text, "Synthetic green kite.\r\n");
    assert.equal(material.metadata.title, "Synthetic idea");
    const read = await client.callTool({
      name: "read",
      arguments: { scope: args.scope, id: material.source.id },
    });
    assert.equal(
      z
        .object({ file: z.object({ contentBase64: z.string() }) })
        .parse(read.structuredContent).file.contentBase64,
      args.contentBase64,
    );
    const denied = await client.callTool({
      name: "read",
      arguments: { scope: "forbidden", id: material.source.id },
    });
    assert.equal(denied.isError, true);
    assert.equal(JSON.stringify(denied).includes("green kite"), false);
    const deniedWrite = await client.callTool({
      name: "remember",
      arguments: {
        version: 1,
        scope: "forbidden",
        idempotencyKey: "material-001",
        text: "Synthetic note",
      },
    });
    assert.equal(deniedWrite.isError, true);
    const malformed = await client.callTool({
      name: "remember",
      arguments: {
        version: 1,
        scope: args.scope,
        idempotencyKey: "bad-file",
        file: {
          filename: args.filename,
          mediaType: args.mediaType,
          contentBase64: "not base64",
        },
      },
    });
    assert.equal(malformed.isError, true);
  } finally {
    await client.close();
    await mcp.close();
    store.close();
  }
});
