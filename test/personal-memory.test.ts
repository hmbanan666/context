import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import type { ClientGrants } from "../src/access.js";
import { protectMcp } from "../src/auth.js";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

const scope = "private:personal";
const resource = "https://context.kosarev.space/mcp";
const issuer = "https://context.kosarev.space/auth/realms/context";
const grants: ClientGrants = {
  "context-chatgpt": { read: [scope], write: [scope], process: [] },
  "context-codex": { read: [scope], write: [], process: [] },
};
const key = await generateKeyPair("RS256");
const jwk = await exportJWK(key.publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] });

async function openMemory(path: string, personalMemory = true) {
  const store = new SourceStore(path);
  const mcp = createContextMcp(store, [], true, {
    clientGrants: grants,
    personalMemory,
  });
  const handler = protectMcp(
    mcp,
    { resource, issuer, ownerSubject: "synthetic-owner", clientGrants: grants },
    keys,
  );
  const clients: Client[] = [];
  return {
    store,
    handler,
    async connect(
      clientId = "context-chatgpt",
      scopes = ["context:read", "context:write", scope],
      subject = "synthetic-owner",
    ) {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        sub: subject,
        azp: clientId,
        scope: scopes.join(" "),
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience(resource)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(key.privateKey);
      const client = new Client({
        name: "personal-pilot-fixture",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => handler.fetch(new Request(input, init)),
        }),
      );
      return client;
    },
    async close() {
      for (const client of clients) await client.close();
      await mcp.close();
      store.close();
    },
  };
}

const savedSchema = z.object({
  version: z.literal(1),
  duplicate: z.boolean(),
  material: z.object({
    source: z.object({
      id: z.string(),
      text: z.string(),
      scope: z.string(),
      origin: z.string(),
      capturedAt: z.string(),
      checksum: z.string(),
      status: z.literal("unreviewed"),
    }),
    metadata: z.object({ createdAt: z.string().optional() }),
  }),
});

test("remember saves an original without user-selected scopes or signatures and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-personal-"));
  const path = join(directory, "memory.db");
  let memory = await openMemory(path);
  const input = {
    text: "Fictional diary: the paper observatory opened after the rain.\nKeep this exact original.",
    metadata: { createdAt: "2026-09-12T18:00:00+02:00" },
    idempotencyKey: "fictional-diary-001",
  };
  try {
    let writer = await memory.connect();
    const result = await writer.callTool({
      name: "remember",
      arguments: input,
    });
    assert.ok(!result.isError, JSON.stringify(result));
    const saved = savedSchema.parse(result.structuredContent);
    assert.equal(saved.material.source.text, input.text);
    assert.equal(saved.material.source.scope, scope);
    assert.equal(saved.material.source.origin, "mcp:context-chatgpt");
    assert.equal(saved.material.metadata.createdAt, input.metadata.createdAt);
    assert.equal(saved.duplicate, false);
    await memory.close();
    memory = await openMemory(path);
    writer = await memory.connect();
    const retry = await writer.callTool({ name: "remember", arguments: input });
    assert.deepEqual(savedSchema.parse(retry.structuredContent), {
      ...saved,
      duplicate: true,
    });
    const reader = await memory.connect("context-codex");
    const original = await reader.callTool({
      name: "read_material",
      arguments: { version: 1, scope, id: saved.material.source.id },
    });
    assert.ok(!original.isError);
    assert.deepEqual(
      z.object({ material: z.unknown() }).parse(original.structuredContent)
        .material,
      { ...saved.material, metadata: { type: "note", ...input.metadata } },
    );
    const conflict = await writer.callTool({
      name: "remember",
      arguments: { ...input, text: "Fictional changed content" },
    });
    assert.equal(conflict.isError, true);
    assert.equal(
      z.object({ error: z.string() }).parse(conflict.structuredContent).error,
      "idempotency_conflict",
    );
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const contextSchema = z.object({
  version: z.literal(1),
  sources: z.array(
    z.object({
      source: savedSchema.shape.material.shape.source,
      metadata: z.object({ createdAt: z.string().optional() }),
    }),
  ),
  totalMatchingSources: z.number(),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  oversizedSources: z.array(
    z.object({ id: z.string(), requiredBytes: z.number() }),
  ),
});

test("memory context covers a period beyond the recent twenty, handles offsets and isolates a stable paginated selection", async () => {
  const memory = await openMemory(":memory:");
  try {
    const writer = await memory.connect();
    const expectedIds = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      const response = await writer.callTool({
        name: "remember",
        arguments: {
          text: `Fictional September diary ${day}: the paper observatory hosted a reading.`,
          metadata: {
            createdAt: `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`,
          },
          idempotencyKey: `september-${day}`,
        },
      });
      expectedIds.add(
        savedSchema.parse(response.structuredContent).material.source.id,
      );
    }
    // This authored date belongs to August in UTC, although its written date is September.
    await writer.callTool({
      name: "remember",
      arguments: {
        text: "Fictional August boundary excluded",
        metadata: { createdAt: "2026-09-01T00:30:00+02:00" },
        idempotencyKey: "boundary",
      },
    });
    memory.store.capture({
      version: 1,
      scope: "synthetic:other",
      origin: "fixture",
      text: "Foreign observatory diary",
      idempotencyKey: "foreign",
    });
    const reader = await memory.connect("context-codex");
    const filters = {
      from: "2026-09-01T00:00:00Z",
      until: "2026-10-01T00:00:00Z",
      limit: 7,
    };
    const first = await reader.callTool({
      name: "memory_context",
      arguments: filters,
    });
    assert.ok(!first.isError, JSON.stringify(first));
    let page = contextSchema.parse(first.structuredContent);
    assert.equal(page.totalMatchingSources, 28);
    assert.equal(page.sources.length, 7);
    assert.equal(page.sources[0]?.metadata.createdAt, "2026-09-28T12:00:00Z");
    const ids = page.sources.map(({ source }) => source.id);
    const cursor = page.nextCursor;
    assert.ok(cursor);
    // A late/backdated arrival must not shift or enter the existing scan.
    await writer.callTool({
      name: "remember",
      arguments: {
        text: "Fictional late arrival",
        metadata: { createdAt: "2026-09-15T12:00:00Z" },
        idempotencyKey: "late",
      },
    });
    let pages = 1;
    while (page.nextCursor) {
      assert.ok(pages++ < 10, "pagination must terminate");
      const response = await reader.callTool({
        name: "memory_context",
        arguments: { ...filters, cursor: page.nextCursor },
      });
      assert.ok(!response.isError);
      page = contextSchema.parse(response.structuredContent);
      assert.equal(page.totalMatchingSources, 28);
      ids.push(...page.sources.map(({ source }) => source.id));
    }
    assert.equal(ids.length, 28);
    assert.deepEqual(new Set(ids), expectedIds);
    const changed = await reader.callTool({
      name: "memory_context",
      arguments: { ...filters, from: "2026-08-01T00:00:00Z", cursor },
    });
    assert.equal(changed.isError, true);
    const search = await reader.callTool({
      name: "memory_context",
      arguments: { ...filters, query: "missingword observatory", limit: 20 },
    });
    assert.equal(
      contextSchema.parse(search.structuredContent).totalMatchingSources,
      28,
    );
  } finally {
    await memory.close();
  }
});

test("personal tools enforce owner, operation and independent client grants before disclosing data or counts", async () => {
  const memory = await openMemory(":memory:");
  try {
    const writer = await memory.connect();
    const saved = savedSchema.parse(
      (
        await writer.callTool({
          name: "remember",
          arguments: {
            text: "Fictional private amber observatory",
            idempotencyKey: "protected",
          },
        })
      ).structuredContent,
    );
    const tools = (await writer.listTools()).tools;
    for (const name of ["remember", "memory_context"]) {
      const tool = tools.find((tool) => tool.name === name);
      assert.ok(tool);
      assert.ok(
        JSON.stringify(tool._meta).includes(scope),
        "personal tool must advertise its exact data consent",
      );
    }
    for (const scopes of [["context:read", "context:write"], [scope]]) {
      const denied = await memory.connect("context-chatgpt", scopes);
      for (const request of [
        { name: "memory_context", arguments: {} },
        {
          name: "remember",
          arguments: { text: "Fictional denied", idempotencyKey: "denied" },
        },
        {
          name: "read_material",
          arguments: { version: 1, scope, id: saved.material.source.id },
        },
      ]) {
        const result = await denied.callTool(request);
        assert.equal(result.isError, true);
        assert.equal(
          JSON.stringify(result).includes(saved.material.source.text),
          false,
        );
        assert.equal(
          JSON.stringify(result).includes("totalMatchingSources"),
          false,
        );
      }
    }
    // A signed write scope cannot override the server's read-only Codex grant.
    const reader = await memory.connect("context-codex");
    assert.equal(
      (
        await reader.callTool({
          name: "remember",
          arguments: { text: "Fictional denied", idempotencyKey: "read-only" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await writer.callTool({
          name: "remember",
          arguments: {
            text: "Fictional denied",
            idempotencyKey: "scope-injection",
            scope: "synthetic:other",
          },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await reader.callTool({
          name: "memory_context",
          arguments: { scope: "synthetic:other" },
        })
      ).isError,
      true,
    );
    await assert.rejects(() =>
      memory.connect("context-chatgpt", ["context:read", scope], "wrong-owner"),
    );
    assert.equal(
      (await memory.handler.fetch(new Request(resource, { method: "POST" })))
        .status,
      401,
    );
    const context = contextSchema.parse(
      (await reader.callTool({ name: "memory_context", arguments: {} }))
        .structuredContent,
    );
    assert.equal(context.totalMatchingSources, 1);
    assert.equal(context.truncated, false);
  } finally {
    await memory.close();
  }
  const disabled = await openMemory(":memory:", false);
  try {
    const client = await disabled.connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes("remember"), false);
    assert.equal(names.includes("memory_context"), false);
    assert.equal(
      (
        await client.callTool({
          name: "capture",
          arguments: {
            version: 1,
            scope,
            text: "Fictional denied",
            origin: "fixture",
            idempotencyKey: "disabled",
          },
        })
      ).isError,
      true,
    );
  } finally {
    await disabled.close();
  }
  const store = new SourceStore(":memory:");
  try {
    assert.throws(() => createContextMcp(store, [scope]));
    assert.throws(() =>
      createContextMcp(store, ["synthetic:test"], false, {
        personalMemory: true,
      }),
    );
  } finally {
    store.close();
  }
});

test("byte-bounded context advances without losing originals, and rejects malformed filters and cursors", async () => {
  const memory = await openMemory(":memory:");
  try {
    const writer = await memory.connect();
    const expected = [];
    for (let i = 0; i < 4; i++) {
      expected.push(
        savedSchema.parse(
          (
            await writer.callTool({
              name: "remember",
              arguments: {
                text: `Fictional entry ${i}: ${"абв😀 ".repeat(i === 3 ? 700 : 20)}`,
                metadata: { createdAt: "2026-09-02T00:00:00Z" },
                idempotencyKey: `budget-${i}`,
              },
            })
          ).structuredContent,
        ).material.source.id,
      );
    }
    const reader = await memory.connect("context-codex");
    let cursor: string | null = null;
    const observed: string[] = [];
    let omitted = 0;
    for (let i = 0; i < 10; i++) {
      const result = await reader.callTool({
        name: "memory_context",
        arguments: { maxBytes: 1500, ...(cursor ? { cursor } : {}) },
      });
      assert.ok(!result.isError);
      assert.ok(
        Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8") <=
          1500,
      );
      const page = contextSchema.parse(result.structuredContent);
      observed.push(
        ...page.sources.map(({ source }) => source.id),
        ...page.oversizedSources.map(({ id }) => id),
      );
      for (const oversized of page.oversizedSources) {
        omitted++;
        assert.ok(oversized.requiredBytes > 1500);
        assert.equal(page.truncated, true);
        const full = await reader.callTool({
          name: "read_material",
          arguments: { version: 1, scope, id: oversized.id },
        });
        assert.ok(!full.isError);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.equal(omitted, 1);
    assert.deepEqual(observed, expected.reverse());
    for (const input of [
      { from: "2026-10-01T00:00:00Z", until: "2026-09-01T00:00:00Z" },
      { from: "2026-09-01" },
      { cursor: "invalid" },
      { query: "***" },
      { query: Array.from({ length: 17 }, (_, i) => `word${i}`).join(" ") },
      { limit: 500000 },
      { maxBytes: 10000000 },
    ])
      assert.equal(
        (await reader.callTool({ name: "memory_context", arguments: input }))
          .isError,
        true,
      );
    const empty = await reader.callTool({
      name: "memory_context",
      arguments: { query: '" OR absenttoken NOT *' },
    });
    assert.ok(!empty.isError);
    assert.equal(
      contextSchema.parse(empty.structuredContent).totalMatchingSources,
      0,
    );
  } finally {
    await memory.close();
  }
});

test("a restored private inbox keeps original bytes, metadata, timeline and retry identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-private-restore-"));
  const path = join(directory, "memory.db");
  const snapshot = join(directory, "snapshot.db"),
    restored = join(directory, "restored.db");
  const memory = await openMemory(path);
  const input = {
    text: "Fictional restored diary\r\nСинтетическая заметка.",
    idempotencyKey: "restore",
    metadata: { createdAt: "2026-09-02T00:00:00Z" },
  };
  try {
    const writer = await memory.connect();
    const saved = savedSchema.parse(
      (await writer.callTool({ name: "remember", arguments: input }))
        .structuredContent,
    );
    await backupDatabase(path, snapshot);
    await restoreDatabase(snapshot, restored);
    const clone = await openMemory(restored);
    try {
      const freshWriter = await clone.connect();
      assert.deepEqual(
        savedSchema.parse(
          (await freshWriter.callTool({ name: "remember", arguments: input }))
            .structuredContent,
        ),
        { ...saved, duplicate: true },
      );
      const freshReader = await clone.connect("context-codex");
      const page = contextSchema.parse(
        (
          await freshReader.callTool({
            name: "memory_context",
            arguments: {
              from: "2026-09-01T00:00:00Z",
              until: "2026-10-01T00:00:00Z",
            },
          })
        ).structuredContent,
      );
      assert.equal(page.totalMatchingSources, 1);
      assert.deepEqual(page.sources[0], saved.material);
    } finally {
      await clone.close();
    }
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("every accepted timezone offset remains retrievable with the same timestamp semantics as filters", async () => {
  const memory = await openMemory(":memory:");
  try {
    const writer = await memory.connect();
    for (const [index, createdAt] of [
      "2026-09-01T12:00:00+15:00",
      "2026-09-01T00:00:00+23:59",
      "0000-01-01T00:00:00+01:00",
    ].entries()) {
      const saved = await writer.callTool({
        name: "remember",
        arguments: {
          text: `Fictional timezone boundary ${index}`,
          metadata: { createdAt },
          idempotencyKey: `offset-${index}`,
        },
      });
      assert.ok(!saved.isError);
    }
    const reader = await memory.connect("context-codex");
    const all = await reader.callTool({
      name: "memory_context",
      arguments: {},
    });
    assert.ok(!all.isError, JSON.stringify(all));
    assert.equal(contextSchema.parse(all.structuredContent).sources.length, 3);
    const filtered = await reader.callTool({
      name: "memory_context",
      arguments: {
        from: "2026-09-01T12:00:00+15:00",
        until: "2026-09-01T13:00:00+15:00",
      },
    });
    assert.ok(!filtered.isError);
    const page = contextSchema.parse(filtered.structuredContent);
    assert.equal(page.totalMatchingSources, 1);
    assert.equal(
      page.sources[0]?.metadata.createdAt,
      "2026-09-01T12:00:00+15:00",
    );
  } finally {
    await memory.close();
  }
});
