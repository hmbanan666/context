import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { JobStore } from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

// Synthetic strings only. Check responses AND durable bytes, including WAL/FTS.
const data = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;
const secret = "ghp_fictionalSecret123456";
const text = `Synthetic garden. token=${secret}`;
const retained = "Synthetic garden. token=[REDACTED]";

test("every MCP source writer redacts before storage, checksums and retry identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-redaction-"));
  const store = new SourceStore(join(directory, "context.db"));
  const mcp = createContextMcp(store, ["personal"]);
  const client = new Client({ name: "redaction-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  try {
    for (const name of [
      "capture",
      "capture_material",
      "remember",
      "capture_file",
    ]) {
      const args = {
        version: 1,
        scope: "personal",
        idempotencyKey: name,
        ...(name === "remember" ? {} : { origin: `token=${secret}` }),
        ...(name === "capture_file"
          ? {
              filename: "note.txt",
              mediaType: "text/plain",
              contentBase64: Buffer.from(text).toString("base64"),
            }
          : { text }),
        ...(name === "capture"
          ? {}
          : {
              metadata: {
                title: `token=${secret}`,
                sourceUri: `https://example.invalid/?token=${secret}`,
              },
            }),
      };
      const saved = await client.callTool({ name, arguments: args });
      assert.ok(!saved.isError, name);
      assert.ok(!JSON.stringify(saved).includes(secret), name);
      const payload = saved.structuredContent as {
        source?: { id: string };
        material?: { source: { id: string } };
      };
      const id = (payload.source ?? payload.material?.source)?.id;
      assert.ok(id);
      const lookup = { version: 1, scope: "personal", id };
      const read = await client.callTool({
        name: "read_material",
        arguments: lookup,
      });
      const material = (
        read.structuredContent as {
          material: { source: { text: string; checksum: string } };
        }
      ).material;
      assert.equal(material.source.text, retained);
      assert.equal(
        material.source.checksum,
        createHash("sha256").update(retained).digest("hex"),
      );
      assert.ok(!JSON.stringify(read).includes(secret));
      if (name === "capture_file") {
        const file = await client.callTool({
          name: "read_file",
          arguments: lookup,
        });
        const bytes = (
          file.structuredContent as { file: { contentBase64: string } }
        ).file.contentBase64;
        assert.equal(Buffer.from(bytes, "base64").toString(), retained);
      }
      const retry = await client.callTool({ name, arguments: args });
      assert.equal(data(retry).duplicate, true);
      const cleanRetry = await client.callTool({
        name,
        arguments: JSON.parse(
          JSON.stringify(args).replaceAll(secret, "[REDACTED]"),
        ),
      });
      // Base64 contents are redacted on decode; other fields may already be redacted.
      assert.equal(data(cleanRetry).duplicate, true);
    }
    for (const file of await readdir(directory)) {
      assert.ok(
        !(await readFile(join(directory, file))).includes(Buffer.from(secret)),
        file,
      );
    }
  } finally {
    await client.close();
    await mcp.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("knowledge, relation and queue writes cannot persist secrets in text, provenance or retry keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-derived-redaction-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const jobs = new JobStore(path);
  const mcp = createContextMcp(sources, ["personal"], false, {
    knowledge,
    jobs,
  });
  const client = new Client({ name: "redaction-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({
      name,
      arguments: { version: 1, scope: "personal", ...args },
    });
  try {
    const saved = await call("remember", { text, idempotencyKey: "source" });
    const sourceId = (
      saved.structuredContent as { material: { source: { id: string } } }
    ).material.source.id;
    const provenance = {
      sourceRefs: [{ sourceId, quote: text }],
      creator: {
        kind: "model",
        name: `token=${secret}`,
        version: `password=${secret}`,
      },
    };
    const ids: string[] = [];
    for (const key of ["one", "two"]) {
      const args = { ...provenance, text, kind: "idea", idempotencyKey: key };
      const added = await call("add_knowledge", args);
      assert.ok(!added.isError);
      assert.ok(!JSON.stringify(added).includes(secret));
      const id = (added.structuredContent as { item: { id: string } }).item.id;
      ids.push(id);
      const read = await call("read_knowledge", { id });
      assert.ok(!JSON.stringify(read).includes(secret));
      assert.equal(data(await call("add_knowledge", args)).duplicate, true);
    }
    const relation = {
      ...provenance,
      fromId: ids[0],
      toId: ids[1],
      kind: "supports",
      idempotencyKey: "relation",
    };
    const related = await call("relate_knowledge", relation);
    assert.ok(!related.isError);
    assert.ok(!JSON.stringify(related).includes(secret));
    assert.equal(
      data(await call("relate_knowledge", relation)).duplicate,
      true,
    );
    assert.ok(
      !JSON.stringify(await call("read_relations", {})).includes(secret),
    );
    // Secret-bearing identities must be rejected, never collapsed to one marker.
    for (const [name, args] of [
      ["remember", { text }],
      ["add_knowledge", { ...provenance, text, kind: "idea" }],
      ["relate_knowledge", relation],
      ["queue_processing", { sourceId }],
    ] as const) {
      const rejected = await call(name, { ...args, idempotencyKey: secret });
      assert.equal(rejected.isError, true, name);
      assert.ok(!JSON.stringify(rejected).includes(secret), name);
    }
    for (const file of await readdir(directory)) {
      assert.ok(
        !(await readFile(join(directory, file))).includes(Buffer.from(secret)),
        file,
      );
    }
  } finally {
    await client.close();
    await mcp.close();
    jobs.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
