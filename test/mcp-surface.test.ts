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

const scope = "projects";
const savedSchema = z.object({
  material: z.object({
    source: z.object({ id: z.string(), text: z.string(), origin: z.string() }),
  }),
  duplicate: z.boolean(),
});
const file = {
  filename: "note.md",
  mediaType: "text/markdown",
  contentBase64: Buffer.from(
    "Synthetic cobalt decision\npassword=fictional-secret-value",
  ).toString("base64"),
};
const object = z.record(z.string(), z.unknown());

async function open() {
  const directory = await mkdtemp(join(tmpdir(), "context-surface-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const jobs = new JobStore(path);
  const mcp = createContextMcp(sources, [scope, "other"], false, {
    knowledge,
    jobs,
  });
  const client = new Client({ name: "surface-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: { scope, ...args } });
    },
    async close() {
      await client.close();
      await mcp.close();
      jobs.close();
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("remember accepts a text file with safe retries, redaction and exact readback", async () => {
  const mcp = await open();
  try {
    const input = {
      file,
      idempotencyKey: "file",
      metadata: { title: "Synthetic decision" },
    };
    const saved = await mcp.call("remember", input);
    assert.ok(!saved.isError, JSON.stringify(saved));
    const { material } = savedSchema.parse(saved.structuredContent);
    assert.equal(material.source.origin, "mcp:local");
    assert.ok(!material.source.text.includes("fictional-secret-value"));
    const retry = await mcp.call("remember", input);
    assert.deepEqual(retry.structuredContent, {
      ...z.record(z.string(), z.unknown()).parse(saved.structuredContent),
      duplicate: true,
    });
    const read = await mcp.call("read", { id: material.source.id });
    assert.ok(!read.isError);
    const data = z
      .object({
        file: z.object({ contentBase64: z.string() }),
        relations: z.array(z.unknown()),
      })
      .parse(read.structuredContent);
    assert.equal(
      Buffer.from(data.file.contentBase64, "base64").toString(),
      material.source.text,
    );
    assert.deepEqual(data.relations, []);
    for (const invalid of [
      { ...input, text: "Ambiguous second source" },
      { idempotencyKey: "empty" },
      { ...input, file: { ...file, contentBase64: "bad base64" } },
      { ...input, file: { ...file, mediaType: "text/plain" } },
      { ...input, metadata: { type: "note" } },
      {
        ...input,
        file: {
          ...file,
          contentBase64: Buffer.from("x".repeat(16385)).toString("base64"),
        },
      },
    ])
      assert.equal((await mcp.call("remember", invalid)).isError, true);
    const conflict = await mcp.call("remember", {
      ...input,
      metadata: { title: "Changed" },
    });
    assert.equal(
      z.object({ error: z.string() }).parse(conflict.structuredContent).error,
      "idempotency_conflict",
    );
  } finally {
    await mcp.close();
  }
});

test("all legacy names remain callable while discovery advertises only four annotated tools", async () => {
  const mcp = await open();
  const called = new Set<string>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.call(name, { version: 1, ...args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    called.add(name);
    return object.parse(result.structuredContent);
  };
  try {
    const listed = (await mcp.client.listTools()).tools;
    assert.deepEqual(listed.map((t) => t.name).sort(), [
      "read",
      "remember",
      "search",
      "timeline",
    ]);
    for (const tool of listed) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: tool.name !== "remember",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const original = await call("capture", {
      text: "Synthetic cobalt original",
      origin: "fixture",
      idempotencyKey: "original",
    });
    const source = z
      .object({ id: z.string(), text: z.string() })
      .parse(original.source);
    assert.deepEqual((await call("recall", { id: source.id })).sources, [
      original.source,
    ]);
    const note = await call("capture_material", {
      text: "Synthetic cobalt material",
      origin: "fixture",
      idempotencyKey: "material",
    });
    const material = savedSchema.parse(note).material;
    assert.deepEqual(
      (await call("read_material", { id: material.source.id })).material,
      note.material,
    );
    const fileSaved = await call("capture_file", {
      ...file,
      origin: "fixture",
      idempotencyKey: "file",
    });
    const fileId = savedSchema.parse(fileSaved).material.source.id;
    const bytes = (await call("read_file", { id: fileId })).file;
    assert.deepEqual((await call("read", { id: fileId })).file, bytes);
    assert.deepEqual(
      (await call("read", { id: source.id })).material,
      (await call("read_material", { id: source.id })).material,
    );
    const remembered = await call("remember", {
      text: "Synthetic cobalt decision",
      idempotencyKey: "note",
    });
    assert.equal(
      savedSchema.parse(remembered).material.source.origin,
      "mcp:local",
    );
    const memory = await call("memory_context", {});
    assert.equal(memory.totalMatchingSources, 4);
    const knowledgeInput = {
      kind: "decision_proposal",
      text: "Synthetic cobalt proposal",
      sourceRefs: [{ sourceId: source.id }],
      creator: { kind: "model", name: "fixture" },
    };
    const itemSchema = z.object({
      id: z.string(),
      status: z.literal("suggested"),
    });
    const first = await call("add_knowledge", {
      ...knowledgeInput,
      idempotencyKey: "first",
    });
    const second = await call("add_knowledge", {
      ...knowledgeInput,
      text: "Replacement cobalt proposal",
      idempotencyKey: "second",
    });
    const firstId = itemSchema.parse(first.item).id;
    const secondId = itemSchema.parse(second.item).id;
    assert.deepEqual((await call("read_knowledge", { id: firstId })).items, [
      first.item,
    ]);
    const relation = await call("relate_knowledge", {
      kind: "supersedes",
      fromId: secondId,
      toId: firstId,
      sourceRefs: knowledgeInput.sourceRefs,
      creator: knowledgeInput.creator,
      idempotencyKey: "relation",
    });
    assert.deepEqual((await call("read_relations", {})).relations, [
      relation.relation,
    ]);
    for (const id of [firstId, secondId]) {
      const read = await call("read", { id });
      assert.deepEqual(read.relations, [relation.relation]);
      assert.equal(itemSchema.parse(read.item).status, "suggested");
      assert.equal(read.truncated, false);
    }
    for (const id of [source.id, material.source.id, fileId, firstId]) {
      assert.equal(
        (await mcp.call("read", { scope: "other", id })).isError,
        true,
      );
      assert.equal(
        (await mcp.call("read", { scope: "forbidden", id })).isError,
        true,
      );
    }
    const queued = await call("queue_processing", {
      sourceId: source.id,
      idempotencyKey: "job",
    });
    const job = z.object({ id: z.string() }).parse(queued.job);
    assert.deepEqual((await call("processing_status", { id: job.id })).jobs, [
      queued.job,
    ]);
    const legacy = await call("context_package", {
      question: "cobalt",
      limit: 2,
    });
    const current = await mcp.call("search", { query: "cobalt", k: 2 });
    const data = object.parse(current.structuredContent);
    assert.deepEqual(data, {
      ...legacy,
      readMore: {
        sources: "read",
        items: "read",
        relations: "read",
        arguments: "scope=this scope, id=selected ID",
      },
    });
    assert.deepEqual([...called].filter((name) => name !== "read").sort(), [
      "add_knowledge",
      "capture",
      "capture_file",
      "capture_material",
      "context_package",
      "memory_context",
      "processing_status",
      "queue_processing",
      "read_file",
      "read_knowledge",
      "read_material",
      "read_relations",
      "recall",
      "relate_knowledge",
      "remember",
    ]);
    for (const [name, args] of [
      [
        "capture",
        {
          text: "missing version",
          origin: "fixture",
          idempotencyKey: "invalid",
        },
      ],
      ["context_package", { query: "wrong legacy schema" }],
      ["read_material", { id: source.id }],
    ] as const)
      assert.equal((await mcp.call(name, args)).isError, true);
  } finally {
    await mcp.close();
  }
});

test("search and timeline honor area, date boundaries, ordering and bounds", async () => {
  const mcp = await open();
  try {
    const ids = [];
    for (const [index, createdAt] of [
      "2026-01-03T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-01-02T01:00:00+01:00",
    ].entries()) {
      const saved = await mcp.call("remember", {
        text: `Synthetic cobalt entry ${index}`,
        idempotencyKey: `entry-${index}`,
        metadata: { createdAt },
      });
      ids.push(savedSchema.parse(saved.structuredContent).material.source.id);
    }
    await mcp.call("remember", {
      scope: "other",
      text: "Foreign cobalt entry",
      idempotencyKey: "foreign",
      metadata: { createdAt: "2026-01-02T00:00:00Z" },
    });
    const timelineSchema = z.object({
      sources: z.array(z.object({ source: z.object({ id: z.string() }) })),
      totalMatchingSources: z.number(),
      truncated: z.boolean(),
    });
    const recent = timelineSchema.parse(
      (await mcp.call("timeline", { limit: 2 })).structuredContent,
    );
    assert.deepEqual(
      recent.sources.map((s) => s.source.id),
      [ids[0], ids[2]],
    );
    assert.equal(recent.totalMatchingSources, 3);
    assert.equal(recent.truncated, true);
    const dates = {
      since: "2026-01-02T00:00:00Z",
      until: "2026-01-03T00:00:00Z",
    };
    const period = timelineSchema.parse(
      (await mcp.call("timeline", dates)).structuredContent,
    );
    assert.deepEqual(
      period.sources.map((s) => s.source.id),
      [ids[2]],
    );
    assert.equal(period.totalMatchingSources, 1);
    assert.equal(period.truncated, false);
    const search = await mcp.call("search", {
      ...dates,
      query: "cobalt",
      k: 1,
    });
    assert.deepEqual(
      z
        .object({ sources: z.array(z.object({ id: z.string() })) })
        .parse(search.structuredContent)
        .sources.map((s) => s.id),
      [ids[2]],
    );
    for (const name of ["timeline", "search"]) {
      for (const invalid of [
        { since: dates.until, until: dates.since },
        { since: "yesterday" },
        { until: "2026-01-02T00:00:00" },
        { [name === "search" ? "k" : "limit"]: 21 },
        { [name === "search" ? "k" : "limit"]: 0 },
      ])
        assert.equal(
          (
            await mcp.call(name, {
              ...(name === "search" ? { query: "cobalt" } : {}),
              ...invalid,
            })
          ).isError,
          true,
        );
    }
  } finally {
    await mcp.close();
  }
});
