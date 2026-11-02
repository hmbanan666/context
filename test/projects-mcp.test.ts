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
import type { ClientGrants } from "../src/access.js";
import { protectMcp } from "../src/auth.js";
import { JobStore } from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("protected MCP applies area and operation grants to every read, write, processing and context tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-projects-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path),
    knowledge = new KnowledgeStore(path),
    jobs = new JobStore(path);
  const a = "garden",
    b = "orchard";
  const grants: ClientGrants = {
    "context-chatgpt": { read: [a, b], write: [a, b], process: [a, b] },
    "fictional-reader": { read: [a], write: [], process: [] },
  };
  const materialInput = {
    version: 1 as const,
    scope: b,
    origin: "fixture:project",
    idempotencyKey: "file",
    filename: "synthetic.txt",
    mediaType: "text/plain" as const,
    contentBase64: "U3ludGhldGljIHByb2plY3QgQiBzZWNyZXQ=",
  };
  const sa = sources.capture({
    version: 1,
    scope: a,
    text: "Synthetic project A paper observatory",
    origin: "fixture:a",
    idempotencyKey: "source",
  }).source;
  const sb = sources.captureFile(materialInput).material.source;
  const kb = knowledge.add({
    version: 1,
    scope: b,
    kind: "idea",
    text: "Synthetic project B secret",
    sourceRefs: [{ sourceId: sb.id }],
    creator: { kind: "model", name: "fixture" },
    idempotencyKey: "knowledge",
  }).item;
  const jobB = jobs.enqueue({
    version: 1,
    scope: b,
    sourceId: sb.id,
    idempotencyKey: "job",
  }).job;
  const mcp = createContextMcp(sources, [], true, {
    knowledge,
    jobs,
    clientGrants: grants,
  });
  const key = await generateKeyPair("RS256");
  const jwk = await exportJWK(key.publicKey);
  const resource = "https://context.kosarev.space/mcp";
  const config = {
    issuer: "https://context.kosarev.space/auth/realms/context",
    resource,
    ownerSubject: "synthetic-owner",
    clientGrants: grants,
  };
  const handler = protectMcp(
    mcp,
    config,
    createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] }),
  );
  const clients: Client[] = [];
  const connect = async (
    clientId: string,
    operations = ["context:read", "context:write", "context:process"],
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: config.ownerSubject,
      azp: clientId,
      scope: [...operations, a, b].join(" "),
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(config.issuer)
      .setAudience(resource)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key.privateKey);
    const client = new Client({ name: "project-access-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return client;
  };
  try {
    const codex = await connect("fictional-reader");
    const reads = [
      ["recall", { id: sb.id }],
      ["recall", { query: "secret" }],
      ["read_material", { id: sb.id }],
      ["read_file", { id: sb.id }],
      ["read_knowledge", { id: kb.id }],
      ["read_knowledge", {}],
      ["read_relations", {}],
      ["processing_status", { id: jobB.id }],
      ["context_package", { question: "secret" }],
      ["memory_context", {}],
    ] as const;
    for (const [name, args] of reads) {
      const result = await codex.callTool({
        name,
        arguments: { version: 1, scope: b, ...args },
      });
      assert.equal(result.isError, true, name);
      assert.equal(JSON.stringify(result).includes(sb.text), false, name);
      assert.equal(JSON.stringify(result).includes(sb.id), false, name);
    }
    const writes = [
      [
        "remember",
        { text: "Fictional denied", idempotencyKey: "blocked-note" },
      ],
      [
        "capture",
        {
          text: "Synthetic blocked",
          origin: "fixture",
          idempotencyKey: "blocked-capture",
        },
      ],
      [
        "capture_material",
        {
          text: "Synthetic blocked",
          origin: "fixture",
          idempotencyKey: "blocked-material",
        },
      ],
      ["capture_file", { ...materialInput, idempotencyKey: "blocked-file" }],
      [
        "add_knowledge",
        {
          kind: "idea",
          text: "Synthetic blocked",
          creator: { kind: "model", name: "fixture" },
          sourceRefs: [{ sourceId: sa.id }],
          idempotencyKey: "blocked-knowledge",
        },
      ],
      [
        "relate_knowledge",
        {
          kind: "supports",
          fromId: "a",
          toId: "b",
          creator: { kind: "model", name: "fixture" },
          sourceRefs: [{ sourceId: sa.id }],
          idempotencyKey: "blocked-relation",
        },
      ],
      [
        "queue_processing",
        { sourceId: sa.id, idempotencyKey: "blocked-process" },
      ],
    ] as const;
    for (const [name, args] of writes) {
      const result = await codex.callTool({
        name,
        arguments: { ...args, version: 1, scope: a },
      });
      assert.equal(result.isError, true, name);
    }
    const context = await codex.callTool({
      name: "context_package",
      arguments: {
        version: 1,
        scope: a,
        question: "observatory",
        maxBytes: 2048,
      },
    });
    assert.ok(!context.isError);
    assert.ok(JSON.stringify(context).includes(sa.id));
    assert.equal(JSON.stringify(context).includes(sb.id), false);
    assert.ok(
      Buffer.byteLength(JSON.stringify(context.structuredContent)) <= 2048,
    );
    const tools = (await codex.listTools()).tools;
    assert.equal(tools.length, 15);
    for (const name of ["work_context", "project_context", "knowledge_history"])
      assert.ok(!tools.some((tool) => tool.name === name));
    assert.ok(tools.every((tool) => tool._meta?.securitySchemes !== undefined));
    const ownerWithoutProcessing = await connect("context-chatgpt", [
      "context:read",
      "context:write",
    ]);
    const deniedQueue = await ownerWithoutProcessing.callTool({
      name: "queue_processing",
      arguments: {
        version: 1,
        scope: a,
        sourceId: sa.id,
        idempotencyKey: "owner-job",
      },
    });
    assert.equal(deniedQueue.isError, true);
    assert.equal(jobs.list(a).length, 0);
    const owner = await connect("context-chatgpt");
    const queued = await owner.callTool({
      name: "queue_processing",
      arguments: {
        version: 1,
        scope: a,
        sourceId: sa.id,
        idempotencyKey: "owner-job",
      },
    });
    assert.ok(!queued.isError);
    const missingRead = await connect("fictional-reader", ["context:write"]);
    assert.equal(
      (
        await missingRead.callTool({
          name: "context_package",
          arguments: { version: 1, scope: a, question: "observatory" },
        })
      ).isError,
      true,
    );
    // A configured non-personal area supports the same memory journey.
    const note = {
      scope: a,
      text: "Fictional garden diary",
      idempotencyKey: "garden-note",
    };
    const saved = await owner.callTool({ name: "remember", arguments: note });
    assert.ok(!saved.isError);
    const retried = await owner.callTool({ name: "remember", arguments: note });
    assert.deepEqual(retried.structuredContent, {
      ...(saved.structuredContent as object),
      duplicate: true,
    });
    const page = await owner.callTool({
      name: "memory_context",
      arguments: { scope: a, limit: 1 },
    });
    assert.ok(!page.isError);
    const cursor = (page.structuredContent as { nextCursor: string })
      .nextCursor;
    assert.ok(cursor);
    const otherArea = await owner.callTool({
      name: "memory_context",
      arguments: { scope: b, limit: 1, cursor },
    });
    assert.deepEqual(otherArea.structuredContent, {
      version: 1,
      error: "invalid_cursor",
    });
    const defaultDenied = await owner.callTool({
      name: "remember",
      arguments: {
        text: "Fictional denied default",
        idempotencyKey: "default",
      },
    });
    assert.equal(defaultDenied.isError, true);
    assert.equal(sources.list(a).length, 2);
    assert.equal(knowledge.list(a).length, 0);
  } finally {
    for (const client of clients) await client.close();
    await mcp.close();
    jobs.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
