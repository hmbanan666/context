import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("MCP preserves file bytes and metadata and denies material access outside grants", async () => {
  const store = new SourceStore(":memory:");
  const mcp = createContextMcp(store, ["synthetic:materials"]);
  const client = new Client({ name: "materials-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  const args = {
    version: 1,
    scope: "synthetic:materials",
    origin: "fixture:materials",
    idempotencyKey: "file-001",
    filename: "idea.txt",
    mediaType: "text/plain",
    contentBase64: "U3ludGhldGljIGdyZWVuIGtpdGUuDQo=",
    metadata: { title: "Synthetic idea" },
  };
  try {
    const saved = await client.callTool({
      name: "capture_file",
      arguments: args,
    });
    assert.ok(!saved.isError);
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
    const lookup = { version: 1, scope: args.scope, id: material.source.id };
    const file = await client.callTool({
      name: "read_file",
      arguments: lookup,
    });
    assert.equal(
      z
        .object({ file: z.object({ contentBase64: z.string() }) })
        .parse(file.structuredContent).file.contentBase64,
      args.contentBase64,
    );
    for (const name of ["read_file", "read_material"]) {
      const denied = await client.callTool({
        name,
        arguments: { ...lookup, scope: "synthetic:forbidden" },
      });
      assert.equal(denied.isError, true);
      assert.equal(JSON.stringify(denied).includes("green kite"), false);
    }
    for (const name of ["capture_material", "capture_file"]) {
      const input =
        name === "capture_file"
          ? args
          : {
              version: 1,
              scope: args.scope,
              origin: args.origin,
              idempotencyKey: "material-001",
              text: "Synthetic note",
            };
      const denied = await client.callTool({
        name,
        arguments: { ...input, scope: "synthetic:forbidden" },
      });
      assert.equal(denied.isError, true);
    }
    const malformed = await client.callTool({
      name: "capture_file",
      arguments: { ...args, contentBase64: "not base64" },
    });
    assert.equal(malformed.isError, true);
  } finally {
    await client.close();
    await mcp.close();
    store.close();
  }
});
