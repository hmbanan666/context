import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import { buildContextPackage, excerpt } from "../src/context-package.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";
import { openPackageFixture } from "./fixtures/package-client.js";
import { period, scope, seedPackageCorpus } from "./fixtures/package-corpus.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "context-package-test-"));
  const path = join(dir, "db");
  const f = await openPackageFixture(path);
  return {
    ...f,
    dir,
    path,
    async cleanup() {
      await f.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("package finds old derived knowledge, one-hop causes and exact compact source excerpts", async () => {
  const f = await setup();
  try {
    const { ids } = seedPackageCorpus(f.store, f.knowledge);
    const before = f.store.findMaterial(ids.long ?? "", scope);
    const client = await f.connect();
    for (const [question, wanted] of [
      ["Какие истории подходят для книги?", [ids.story, ids.rescue]],
      ["Why did the amber launch slip?", [ids.launch, ids.flood]],
      ["What did the cobalt telescope reveal?", [ids.long]],
    ] as const) {
      const r = await client.callTool({
        name: "context_package",
        arguments: { question, ...period, maxBytes: 4096 },
      });
      assert.ok(!r.isError);
      const data = r.structuredContent as unknown as ReturnType<
        typeof buildContextPackage
      >;
      assert.deepEqual(new Set(data.sources.map((s) => s.id)), new Set(wanted));
      assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 4096);
      for (const s of data.sources) {
        const m = f.store.findMaterial(s.id, scope);
        assert.ok(m);
        assert.equal(s.checksum, m.source.checksum);
        assert.equal(
          s.excerpt.text,
          m.source.text.slice(s.excerpt.start, s.excerpt.end),
        );
        const read = await client.callTool({
          name: "read_material",
          arguments: { version: 1, scope, id: s.id },
        });
        assert.deepEqual(
          (read.structuredContent as Record<string, unknown>)?.material,
          m,
        );
      }
      if (question.includes("amber")) {
        assert.equal(data.relations.length, 1);
        for (const rel of data.relations) {
          assert.ok(data.items.some((k) => k.id === rel.fromId));
          assert.ok(data.items.some((k) => k.id === rel.toId));
          assert.equal(rel.status, "suggested");
        }
      }
      if (question.includes("cobalt")) {
        assert.ok(data.sources[0]?.excerpt.text.includes("three blue rings"));
        assert.equal(data.sources[0]?.excerpt.truncated, true);
      }
    }
    assert.deepEqual(f.store.findMaterial(ids.long ?? "", scope), before);
  } finally {
    await f.cleanup();
  }
});

test("authorization precedes package counts and traversal; private defaults never enable no-auth access", async () => {
  const f = await setup();
  try {
    seedPackageCorpus(f.store, f.knowledge);
    const noRead = await f.connect("context-chatgpt", ["context:write", scope]);
    const noData = await f.connect("context-chatgpt", ["context:read"]);
    const forgedScope = await f.connect("context-codex", [
      "context:read",
      scope,
      "synthetic:forbidden",
    ]);
    for (const [client, args] of [
      [noRead, {}],
      [noData, {}],
      [forgedScope, { scope: "synthetic:forbidden" }],
    ] as const) {
      const r = await client.callTool({
        name: "context_package",
        arguments: { question: "platinum", ...args },
      });
      assert.equal(r.isError, true);
      assert.equal(
        (r.structuredContent as Record<string, unknown>)?.sources,
        undefined,
      );
      assert.equal(
        (r.structuredContent as Record<string, unknown>)?.coverage,
        undefined,
      );
    }
    const wrongOwner = await f
      .connect("context-chatgpt", ["context:read", scope], "foreign-owner")
      .then(
        () => false,
        () => true,
      );
    assert.equal(wrongOwner, true);
    const ordinary = await f.connect("context-codex");
    const r = await ordinary.callTool({
      name: "context_package",
      arguments: { question: "platinum" },
    });
    assert.ok(!r.isError);
    assert.deepEqual(
      (r.structuredContent as Record<string, unknown>)?.sources,
      [],
    );
    const original = await ordinary.callTool({
      name: "memory_context",
      arguments: period,
    });
    assert.ok(!original.isError);
  } finally {
    await f.cleanup();
  }
  const disabled = await setup();
  try {
    const { createContextMcp } = await import("../src/mcp.js");
    const mcp = createContextMcp(disabled.store, ["synthetic:package"], false, {
      knowledge: disabled.knowledge,
    });
    const client = new Client({
      name: "no-auth-package-fixture",
      version: "1",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
          fetch: async (input, init) => mcp.fetch(new Request(input, init)),
        }),
      );
      const response = await client.callTool({
        name: "context_package",
        arguments: { question: "private" },
      });
      assert.equal(response.isError, true);
      assert.equal(
        (response.structuredContent as Record<string, unknown>)?.coverage,
        undefined,
      );
    } finally {
      await client.close();
    }
    await mcp.close();
  } finally {
    await disabled.cleanup();
  }
});

test("date boundaries, graph provenance, rejected items and bounded coverage fail closed", async () => {
  const f = await setup();
  try {
    const { ids } = seedPackageCorpus(f.store, f.knowledge);
    const query = { question: "timezone boundary", ...period };
    const result = buildContextPackage(f.store, f.knowledge, query);
    assert.deepEqual(
      result.sources.map((s) => s.id),
      [ids.boundary],
    );
    const empty = buildContextPackage(f.store, f.knowledge, {
      question: "Какие истории подходят для книги?",
      from: "2027-01-01T00:00:00Z",
    });
    assert.deepEqual(empty.sources, []);
    assert.deepEqual(empty.items, []);
    const mixed = f.knowledge.add({
      version: 1,
      scope,
      kind: "observation",
      text: "mixedscope story",
      sourceRefs: [
        { sourceId: ids.story ?? "" },
        { sourceId: ids.excluded ?? "" },
      ],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "mixed",
    }).item;
    assert.deepEqual(
      buildContextPackage(f.store, f.knowledge, {
        question: "mixedscope",
        ...period,
      }).items,
      [],
    );
    const rejected = f.knowledge.add({
      version: 1,
      scope,
      kind: "idea",
      text: "rejectedmarker",
      sourceRefs: [{ sourceId: ids.story ?? "" }],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "rejected",
    }).item;
    // Trusted store boundary fixture; signature verification is covered by owner-review tests.
    f.knowledge.review(
      {
        version: 1,
        scope,
        id: rejected.id,
        status: "rejected",
        evidence: "Synthetic rejection",
        idempotencyKey: "rejection",
      },
      {
        kind: "verified-owner-signature",
        subject: "synthetic-owner",
        authenticated: true,
        signature: `${"A".repeat(86)}==`,
      },
    );
    assert.equal(
      buildContextPackage(f.store, f.knowledge, { question: "rejectedmarker" })
        .coverage.knowledgeMatches,
      0,
    );
    const db = new DatabaseSync(f.path);
    db.prepare("UPDATE knowledge_items SET source_refs=? WHERE id=?").run(
      JSON.stringify([{ sourceId: ids.story, quote: "MISSING QUOTE" }]),
      mixed.id,
    );
    db.close();
    const corrupt = buildContextPackage(f.store, f.knowledge, {
      question: "mixedscope",
      ...period,
    });
    assert.deepEqual(corrupt.items, []);
    assert.ok(corrupt.coverage.reasons.includes("invalid_provenance"));
    const huge = buildContextPackage(f.store, f.knowledge, {
      question: "inventory",
      maxBytes: 2048,
      limit: 1,
    });
    assert.ok(huge.truncated);
    assert.ok(huge.coverage.reasons.includes("candidate_limit"));
    assert.ok(huge.coverage.sourceMatches >= 120);
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= 2048);
    for (const size of [2048, 4096, 8192]) {
      const r = buildContextPackage(f.store, f.knowledge, {
        question: "anything",
        mode: "timeline",
        ...period,
        maxBytes: size,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(r)) <= size);
      for (const s of r.sources) assert.notEqual(s.id, ids.excluded);
    }
    assert.throws(() =>
      buildContextPackage(f.store, f.knowledge, { question: "!!!" }),
    );
    assert.throws(() =>
      buildContextPackage(f.store, f.knowledge, {
        question: "x",
        ...period,
        until: period.from,
      }),
    );
    const injection = buildContextPackage(f.store, f.knowledge, {
      question: '" OR * NEAR(foo) -bar',
    });
    assert.deepEqual(injection.sources, []);
  } finally {
    await f.cleanup();
  }
});

test("one-hop expansion excludes second-hop, cross-scope and outside-period provenance", async () => {
  const f = await setup();
  try {
    const make = (label: string, date: string, dataScope = scope) => {
      const source = f.store.captureMaterial({
        version: 1,
        scope: dataScope,
        text: `Synthetic ${label}`,
        origin: "fixture:graph",
        idempotencyKey: label,
        metadata: { createdAt: date },
      }).material.source;
      const item = f.knowledge.add({
        version: 1,
        scope: dataScope,
        kind: "observation",
        text: `Derived ${label}`,
        sourceRefs: [{ sourceId: source.id }],
        creator: { kind: "model", name: "fixture" },
        idempotencyKey: label,
      }).item;
      return { source, item };
    };
    const a = make("seedmarker", "2026-10-01T12:00:00Z");
    const b = make("neighbor", "2026-10-02T12:00:00Z");
    const c = make("distant", "2026-10-03T12:00:00Z");
    const outside = make("outside", "2026-12-01T12:00:00Z");
    const foreign = make(
      "secret",
      "2026-10-01T12:00:00Z",
      "synthetic:forbidden",
    );
    for (const [from, to] of [
      [a, b],
      [b, c],
      [a, outside],
    ] as const) {
      f.knowledge.relate({
        version: 1,
        scope,
        kind: "supports",
        fromId: from.item.id,
        toId: to.item.id,
        sourceRefs: [{ sourceId: to.source.id }],
        creator: { kind: "model", name: "fixture" },
        idempotencyKey: `${from.item.id}-${to.item.id}`,
      });
    }
    const request = { question: "seedmarker", ...period };
    const result = buildContextPackage(f.store, f.knowledge, request);
    assert.deepEqual(
      new Set(result.sources.map((s) => s.id)),
      new Set([a.source.id, b.source.id]),
    );
    assert.equal(result.relations.length, 1);
    assert.ok(result.coverage.reasons.includes("outside_period"));
    // Simulate legacy/corrupt provenance; neither the foreign original nor derived text may escape.
    const db = new DatabaseSync(f.path);
    db.prepare("UPDATE knowledge_items SET source_refs=? WHERE id=?").run(
      JSON.stringify([{ sourceId: foreign.source.id }]),
      a.item.id,
    );
    db.close();
    const closed = buildContextPackage(f.store, f.knowledge, request);
    assert.deepEqual(closed.items, []);
    assert.deepEqual(closed.relations, []);
    assert.deepEqual(
      closed.sources.map((s) => s.id),
      [a.source.id],
    );
    assert.equal(closed.coverage.knowledgeMatches, 0);
  } finally {
    await f.cleanup();
  }
});

test("derived FTS backfills existing knowledge and persists through capture, reopen and restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "package-migration-"));
  const path = join(dir, "db");
  let sources = new SourceStore(path);
  let knowledge = new KnowledgeStore(path);
  try {
    const { ids } = seedPackageCorpus(sources, knowledge);
    const original = sources.findMaterial(ids.story ?? "", scope);
    knowledge.close();
    sources.close();
    const db = new DatabaseSync(path);
    db.exec(
      "DROP TRIGGER knowledge_items_fts_insert; DROP TABLE knowledge_items_fts;",
    );
    db.close();
    sources = new SourceStore(path);
    knowledge = new KnowledgeStore(path);
    assert.equal(
      buildContextPackage(sources, knowledge, { question: "книги", ...period })
        .items.length,
      2,
    );
    const extra = knowledge.add({
      version: 1,
      scope,
      kind: "idea",
      text: "Migrationmarker preserves immutable history",
      sourceRefs: [{ sourceId: ids.story ?? "" }],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "backfill-check",
    }).item;
    assert.equal(
      buildContextPackage(sources, knowledge, { question: "migrationmarker" })
        .items[0]?.id,
      extra.id,
    );
    await backupDatabase(path, join(dir, "backup"));
    await restoreDatabase(join(dir, "backup"), join(dir, "restored"));
    const restoredSources = new SourceStore(join(dir, "restored")),
      restoredKnowledge = new KnowledgeStore(join(dir, "restored"));
    try {
      assert.equal(
        buildContextPackage(restoredSources, restoredKnowledge, {
          question: "migrationmarker",
        }).items[0]?.id,
        extra.id,
      );
      assert.deepEqual(
        restoredSources.findMaterial(ids.story ?? "", scope),
        original,
      );
    } finally {
      restoredKnowledge.close();
      restoredSources.close();
    }
  } finally {
    knowledge.close();
    sources.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Unicode excerpts are exact and never split surrogate pairs", () => {
  const text = `${"😀".repeat(150)}needle ${"🚀".repeat(300)}`;
  const e = excerpt(text, ["needle"], 361);
  assert.equal(e.text, text.slice(e.start, e.end));
  assert.ok(e.text.includes("needle"));
  assert.ok(!/[\uD800-\uDFFF]/u.test(e.text));
});

test("case-fold expansion cannot shift source excerpt offsets", () => {
  const text = `${"İ".repeat(500)} needle useful fact`;
  const e = excerpt(text, ["needle"]);
  assert.ok(e.start >= 0 && e.start <= e.end && e.end <= text.length);
  assert.equal(e.text, text.slice(e.start, e.end));
  assert.ok(e.text.includes("needle useful fact"));
});
