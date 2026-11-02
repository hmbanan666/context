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
    path,
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
        arguments:
          "scope=this scope, id=source/knowledge ID; for relations use fromId or toId",
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

test("remember supersedes facts atomically and visible read/search expose source history", async () => {
  const mcp = await open();
  const save = async (args: Record<string, unknown>) => {
    const result = await mcp.call("remember", args);
    assert.ok(!result.isError, JSON.stringify(result));
    return savedSchema.parse(result.structuredContent);
  };
  const history = async (id: string) =>
    object.parse((await mcp.call("read", { id })).structuredContent);
  try {
    const first = await save({
      text: "Synthetic lunar agents limit 3",
      idempotencyKey: "first-fact",
    });
    const second = await save({
      text: "Synthetic lunar agents limit 2",
      idempotencyKey: "second-fact",
    });
    const ids = [first.material.source.id, second.material.source.id];
    const input = {
      text: "Synthetic lunar agents limit 4",
      idempotencyKey: "update",
      supersedes: ids,
    };
    const current = await save(input);
    const links = z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.string(),
            fromId: z.string(),
            toId: z.string(),
            creator: z.object({ kind: z.string(), name: z.string() }),
          })
          .passthrough(),
      )
      .parse((await history(current.material.source.id)).relations);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((r) => r.toId).sort(), [...ids].sort());
    for (const link of links) {
      assert.equal(link.kind, "supersedes");
      assert.equal(link.fromId, current.material.source.id);
      assert.deepEqual(link.creator, { kind: "user", name: "local" });
      assert.deepEqual((await history(link.toId)).relations, [link]);
    }
    const retry = await save({ ...input, supersedes: [...ids].reverse() });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.material.source.id, current.material.source.id);
    assert.deepEqual(
      (await history(current.material.source.id)).relations,
      links,
    );
    for (const changed of [
      { ...input, supersedes: [ids[0]] },
      { text: input.text, idempotencyKey: input.idempotencyKey },
    ]) {
      const result = await mcp.call("remember", changed);
      assert.equal(result.isError, true);
      assert.equal(
        object.parse(result.structuredContent).error,
        "idempotency_conflict",
      );
    }
    const search = object.parse(
      (await mcp.call("search", { query: "lunar agents" })).structuredContent,
    );
    const cards = z
      .array(z.object({ id: z.string(), supersededBy: z.string().optional() }))
      .parse(search.sources);
    assert.equal(cards.length, 3);
    assert.equal(cards[0]?.id, current.material.source.id);
    for (const old of cards.filter((c) => ids.includes(c.id)))
      assert.equal(old.supersededBy, current.material.source.id);
    const copy = await save({
      file: {
        ...file,
        contentBase64: Buffer.from(input.text).toString("base64"),
      },
      idempotencyKey: "file-update",
      supersedes: [current.material.source.id],
    });
    const duplicate = await mcp.call("relate_knowledge", {
      version: 1,
      idempotencyKey: "duplicate",
      kind: "duplicates",
      fromId: copy.material.source.id,
      toId: current.material.source.id,
      sourceRefs: [{ sourceId: copy.material.source.id }],
      creator: { kind: "user", name: "fixture" },
    });
    assert.ok(!duplicate.isError);
    for (const id of [current.material.source.id, copy.material.source.id]) {
      const relations = z
        .array(z.object({ kind: z.string() }))
        .parse((await history(id)).relations);
      assert.ok(relations.some((r) => r.kind === "duplicates"));
      assert.ok(relations.some((r) => r.kind === "supersedes"));
    }
  } finally {
    await mcp.close();
  }
});

test("invalid supersedes targets and failed relation writes leave no source or consumed retry key", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const mcp = await open();
  const save = async (idempotencyKey: string, area = scope) =>
    savedSchema.parse(
      (
        await mcp.call("remember", {
          scope: area,
          text: `Synthetic original ${idempotencyKey}`,
          idempotencyKey,
        })
      ).structuredContent,
    ).material.source.id;
  const count = async () =>
    object.parse((await mcp.call("timeline", {})).structuredContent)
      .totalMatchingSources;
  try {
    const first = await save("first"),
      second = await save("second"),
      foreign = await save("foreign", "other");
    const input = {
      text: "Synthetic replacement",
      idempotencyKey: "replacement",
    };
    for (const supersedes of [
      [first, "missing"],
      [first, foreign],
      [],
      [first, first],
      [""],
      Array.from({ length: 9 }, (_, i) => `id-${i}`),
    ]) {
      const failed = await mcp.call("remember", { ...input, supersedes });
      assert.equal(failed.isError, true);
      assert.equal(await count(), 2);
      assert.deepEqual(
        object.parse((await mcp.call("read", { id: first })).structuredContent)
          .relations,
        [],
      );
    }
    const db = new DatabaseSync(mcp.path);
    try {
      // Fail the second relation after source/index writes and the first link;
      // observe atomic rollback through MCP rather than inspecting stored rows.
      const last = [first, second].sort().at(-1);
      db.exec(
        `CREATE TRIGGER fixture_relation_failure BEFORE INSERT ON knowledge_relations WHEN new.to_id='${last}' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;`,
      );
      assert.equal(
        (await mcp.call("remember", { ...input, supersedes: [first, second] }))
          .isError,
        true,
      );
      assert.equal(await count(), 2);
      assert.deepEqual(
        object.parse((await mcp.call("read", { id: first })).structuredContent)
          .relations,
        [],
      );
      assert.deepEqual(
        object.parse(
          (await mcp.call("search", { query: "replacement" }))
            .structuredContent,
        ).sources,
        [],
      );
      db.exec("DROP TRIGGER fixture_relation_failure");
    } finally {
      db.close();
    }
    const valid = await mcp.call("remember", {
      ...input,
      supersedes: [first, second],
    });
    assert.ok(!valid.isError, JSON.stringify(valid));
    assert.equal(savedSchema.parse(valid.structuredContent).duplicate, false);
    assert.equal(await count(), 3);
  } finally {
    await mcp.close();
  }
});

test("protected remember supersedes uses the calling client's area write rights and attribution", async () => {
  const { openPackageFixture } = await import("./fixtures/package-client.js");
  const directory = await mkdtemp(
    join(process.cwd(), ".output-surface-supersedes-"),
  );
  const f = await openPackageFixture(join(directory, "db"));
  try {
    const writer = await f.connect();
    const reader = await f.connect("context-codex", [
      "context:read",
      "personal",
    ]);
    const old = savedSchema.parse(
      (
        await writer.callTool({
          name: "remember",
          arguments: { text: "Synthetic lunar limit 3", idempotencyKey: "old" },
        })
      ).structuredContent,
    ).material.source.id;
    const item = f.knowledge.add({
      version: 1,
      scope: "personal",
      idempotencyKey: "idea",
      kind: "observation",
      text: "Synthetic lunar limit",
      sourceRefs: [{ sourceId: old }],
      creator: { kind: "user", name: "fixture" },
    }).item;
    const input = {
      text: "Synthetic lunar limit 4",
      idempotencyKey: "current",
      supersedes: [old, item.id],
    };
    for (const [client, args] of [
      [reader, input],
      [writer, { ...input, scope: "forbidden" }],
    ] as const) {
      assert.equal(
        (await client.callTool({ name: "remember", arguments: args })).isError,
        true,
      );
    }
    assert.equal(f.store.list("personal").length, 1);
    assert.deepEqual(f.knowledge.relations("personal"), []);
    const saved = await writer.callTool({ name: "remember", arguments: input });
    assert.ok(!saved.isError, JSON.stringify(saved));
    const current = savedSchema.parse(saved.structuredContent).material.source
      .id;
    const read = await reader.callTool({
      name: "read",
      arguments: { id: current },
    });
    const links = z
      .array(
        z.object({
          creator: z.object({ kind: z.string(), name: z.string() }),
          toId: z.string(),
        }),
      )
      .parse(object.parse(read.structuredContent).relations);
    assert.equal(links.length, 2);
    for (const link of links)
      assert.deepEqual(link.creator, { kind: "user", name: "context-chatgpt" });
    assert.deepEqual(links.map((r) => r.toId).sort(), [old, item.id].sort());
    const original = await reader.callTool({
      name: "read",
      arguments: { id: old },
    });
    assert.equal(
      z
        .array(z.unknown())
        .parse(object.parse(original.structuredContent).relations).length,
      1,
    );
  } finally {
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
