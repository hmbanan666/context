import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openPackageFixture } from "./fixtures/package-client.js";

test("authorized packages find RU inflections and EN plurals in sources and knowledge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hybrid-search-"));
  const f = await openPackageFixture(join(dir, "db"));
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      text: "Бэкапы проверены. Управление серверами. Gardens bloom.",
      origin: "fixture",
      idempotencyKey: "morphology",
    }).source;
    const item = f.knowledge.add({
      version: 1,
      scope: "personal",
      kind: "observation",
      text: "Планеты. Telescopes.",
      sourceRefs: [{ sourceId: source.id }],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "morphology",
    }).item;
    f.store.capture({
      version: 1,
      scope: "forbidden",
      text: "Бэкап сервер garden telescope планета",
      origin: "fixture",
      idempotencyKey: "hidden",
    });
    const client = await f.connect();
    for (const question of [
      "бэкап",
      "сервер",
      "garden",
      "telescope",
      "планета",
    ]) {
      const result = await client.callTool({
        name: "context_package",
        arguments: { question },
      });
      assert.ok(!result.isError);
      const data = result.structuredContent as {
        sources: { id: string }[];
        items: { id: string }[];
        coverage: { sourceMatches: number; knowledgeMatches: number };
      };
      assert.deepEqual(
        data.sources.map((s) => s.id),
        [source.id],
      );
      if (["telescope", "планета"].includes(question)) {
        assert.deepEqual(
          data.items.map((k) => k.id),
          [item.id],
        );
        assert.equal(data.coverage.knowledgeMatches, 1);
        assert.equal(data.coverage.sourceMatches, 0);
      } else assert.equal(data.coverage.sourceMatches, 1);
    }
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture survives unavailable embeddings; durable backfill enables paraphrases without disclosing other areas", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const dir = await mkdtemp(join(tmpdir(), "hybrid-queue-"));
  const path = join(dir, "db");
  let available = false;
  const embedder = {
    version: "synthetic-v1",
    async embed(text: string) {
      if (!available) throw new Error("Synthetic model unavailable");
      return Float32Array.from(
        /safety copies|restore|восстановить/u.test(text) ? [1, 0] : [0, 1],
      );
    },
  };
  const f = await openPackageFixture(path);
  let index = new EmbeddingIndex(path, embedder);
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      text: "The fictional observatory keeps safety copies nightly.",
      origin: "fixture",
      idempotencyKey: "copies",
    }).source;
    f.store.capture({
      version: 1,
      scope: "forbidden",
      text: "restore safety copies",
      origin: "fixture",
      idempotencyKey: "hidden",
    });
    while (await index.processOne()) {
      /* each unavailable item fails safely */
    }
    assert.equal(index.status("personal").failed, 1);
    assert.equal(
      f.store.search("safety copies", "personal", 10)[0]?.id,
      source.id,
    );
    await index.close();
    available = true;
    index = new EmbeddingIndex(path, embedder);
    index.backfill();
    while (await index.processOne()) {
      /* drain the synthetic queue */
    }
    assert.equal(index.status("personal").completed, 1);
    assert.equal(index.status("personal").chunks, 1);
    const hits = await index.search({
      scope: "personal",
      question: "How can I restore lost observations?",
    });
    assert.deepEqual(
      hits.sources.map((h) => h.id),
      [source.id],
    );
    assert.deepEqual(
      (await index.search({ scope: "empty", question: "restore" })).sources,
      [],
    );
    const { buildContextPackage } = await import("../src/context-package.js");
    const result = buildContextPackage(
      f.store,
      f.knowledge,
      { scope: "personal", question: "How can I restore lost observations?" },
      hits,
    );
    assert.deepEqual(
      result.sources.map((s) => s.id),
      [source.id],
    );
    assert.equal(result.coverage.sourceMatches, 1);
  } finally {
    await index.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP fuses paraphrases with lexical ranks after area, date and knowledge-status filtering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hybrid-mcp-"));
  const f = await openPackageFixture(join(dir, "db"), {
    version: "synthetic-v1",
    async embed(text, purpose) {
      assert.ok(purpose === "passage" || purpose === "query");
      return Float32Array.from(
        /restore|восстановить|safety copies|резерв/u.test(text)
          ? [1, 0]
          : [0, 1],
      );
    },
  });
  try {
    const index = f.embeddings;
    assert.ok(index);
    const client = await f.connect();
    const save = await client.callTool({
      name: "remember",
      arguments: {
        text: "The observatory keeps safety copies nightly.",
        idempotencyKey: "semantic",
        metadata: { createdAt: "2026-10-02T00:00:00Z" },
      },
    });
    assert.ok(!save.isError);
    const source = (
      save.structuredContent as { material: { source: { id: string } } }
    ).material.source;
    f.knowledge.add({
      version: 1,
      scope: "personal",
      kind: "observation",
      text: "Use the reserve to restore observations.",
      sourceRefs: [{ sourceId: source.id }],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "derived",
    });
    for (const [scope, date, key] of [
      ["forbidden", "2026-10-02T00:00:00Z", "hidden"],
      ["personal", "2026-09-01T00:00:00Z", "old"],
    ]) {
      const s = f.store.captureMaterial({
        version: 1,
        scope: scope ?? "",
        text: "restore safety copies",
        origin: "fixture",
        idempotencyKey: key ?? "",
        metadata: { createdAt: date ?? "" },
      }).material.source;
      f.knowledge.add({
        version: 1,
        scope: s.scope,
        kind: "observation",
        text: "restore",
        sourceRefs: [{ sourceId: s.id }],
        creator: { kind: "model", name: "fixture" },
        idempotencyKey: key ?? "",
      });
    }
    const rejected = f.knowledge.add({
      version: 1,
      scope: "personal",
      kind: "observation",
      text: "restore safety copies",
      sourceRefs: [{ sourceId: source.id }],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "rejected",
    }).item;
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(join(dir, "db"));
    legacy
      .prepare(`INSERT INTO knowledge_reviews(id,knowledge_id,scope,status,evidence,reviewer,signed_receipt,created_at)
      VALUES('synthetic-rejection',?,'personal','rejected','Synthetic legacy review','fixture','{}','2026-10-02T00:00:00Z')`)
      .run(rejected.id);
    legacy.close();
    while (await index.processOne()) {
      /* drain */
    }
    for (const question of [
      "How can I restore observations?",
      "Как восстановить наблюдения?",
    ]) {
      const response = await client.callTool({
        name: "context_package",
        arguments: {
          question,
          from: "2026-10-01T00:00:00Z",
          until: "2026-11-01T00:00:00Z",
        },
      });
      assert.ok(!response.isError);
      const data = response.structuredContent as {
        sources: { id: string }[];
        items: { id: string }[];
        coverage: { sourceMatches: number; knowledgeMatches: number };
      };
      assert.deepEqual(
        data.sources.map((s) => s.id),
        [source.id],
      );
      assert.equal(data.items.length, 1);
      assert.equal(data.coverage.sourceMatches, 1);
      assert.equal(data.coverage.knowledgeMatches, 1);
    }
    const denied = await client.callTool({
      name: "context_package",
      arguments: { question: "restore", scope: "forbidden" },
    });
    assert.ok(denied.isError);
    assert.equal(
      (denied.structuredContent as Record<string, unknown>)?.coverage,
      undefined,
    );
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("long-text embeddings retain later passages and their original excerpt offsets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hybrid-chunks-"));
  const f = await openPackageFixture(join(dir, "db"), {
    version: "synthetic-v1",
    async embed(text, purpose) {
      return Float32Array.from(
        purpose === "query" || text.includes("violet rescue capsule")
          ? [1, 0]
          : [0, 1],
      );
    },
  });
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      text: `${"Fictional unrelated garden. ".repeat(150)}A violet rescue capsule holds the surviving charts.`,
      origin: "fixture",
      idempotencyKey: "long",
    }).source;
    assert.ok(f.embeddings);
    while (await f.embeddings.processOne()) {
      /* drain */
    }
    assert.ok(f.embeddings.status("personal").chunks > 1);
    const client = await f.connect();
    const r = await client.callTool({
      name: "context_package",
      arguments: { question: "Recover observations" },
    });
    const data = r.structuredContent as {
      sources: {
        id: string;
        excerpt: { text: string; start: number; end: number };
      }[];
    };
    assert.equal(data.sources[0]?.id, source.id);
    const excerpt = data.sources[0]?.excerpt;
    assert.ok(excerpt?.text.includes("violet rescue capsule"));
    assert.equal(excerpt.text, source.text.slice(excerpt.start, excerpt.end));
    f.embeddings.backfill();
    assert.equal(await f.embeddings.processOne(), false);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuild invalidates in-flight embeddings and can be retried without changing sources", async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const dir = await mkdtemp(join(tmpdir(), "hybrid-rebuild-"));
  const f = await openPackageFixture(join(dir, "db"), {
    version: "synthetic-v1",
    async embed() {
      entered?.();
      await waiting;
      return Float32Array.from([1, 0]);
    },
  });
  try {
    const source = f.store.capture({
      version: 1,
      scope: "personal",
      text: "Synthetic servers preserve backups.",
      origin: "fixture",
      idempotencyKey: "rebuild",
    }).source;
    assert.ok(f.embeddings);
    const running = f.embeddings.processOne();
    await started;
    f.embeddings.rebuild();
    release?.();
    await running;
    assert.equal(f.embeddings.status("personal").chunks, 0);
    assert.equal(f.embeddings.status("personal").queued, 1);
    await f.embeddings.processOne();
    assert.equal(f.embeddings.status("personal").completed, 1);
    assert.deepEqual(f.store.find(source.id, "personal"), source);
    const client = await f.connect();
    const r = await client.callTool({
      name: "context_package",
      arguments: { question: "server" },
    });
    assert.equal(
      (r.structuredContent as { sources: { id: string }[] }).sources[0]?.id,
      source.id,
    );
  } finally {
    release?.();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner rebuild CLI preserves originals and startup backfills automatically with scoped status", async () => {
  const { spawnSync } = await import("node:child_process");
  const { startService } = await import("../src/server.js");
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  const dir = await mkdtemp(join(tmpdir(), "hybrid-startup-"));
  const path = join(dir, "db");
  const f = await openPackageFixture(path);
  const source = f.store.capture({
    version: 1,
    scope: "personal",
    text: "Бэкапы телескопов.",
    origin: "fixture",
    idempotencyKey: "startup",
  }).source;
  f.store.capture({
    version: 1,
    scope: "forbidden",
    text: "Synthetic hidden backups.",
    origin: "fixture",
    idempotencyKey: "hidden",
  });
  await f.close();
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  const client = new Client({ name: "synthetic-search", version: "1" });
  try {
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(
        process.execPath,
        ["dist/scripts/context.js", "index", "rebuild"],
        { env: { ...process.env, CONTEXT_DB_PATH: path }, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).queued, 2);
    }
    service = await startService(
      { databasePath: path, port: 0, localMcpScopes: ["personal"] },
      {
        version: "synthetic-v1",
        async embed() {
          return Float32Array.from([1, 0]);
        },
      },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${service.address.port}/mcp`),
      ),
    );
    let completed = 0;
    for (let i = 0; i < 100 && completed !== 1; i++) {
      const status = await client.callTool({
        name: "processing_status",
        arguments: { version: 1, scope: "personal" },
      });
      assert.ok(!status.isError);
      const data = status.structuredContent as {
        embeddings: {
          completed: number;
          queued: number;
          running: number;
          failed: number;
        };
      };
      completed = data.embeddings.completed;
      assert.equal(
        data.embeddings.completed +
          data.embeddings.queued +
          data.embeddings.running +
          data.embeddings.failed,
        1,
      );
      if (completed !== 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed, 1);
    const response = await client.callTool({
      name: "context_package",
      arguments: { question: "бэкап" },
    });
    assert.equal(
      (response.structuredContent as { sources: { id: string }[] }).sources[0]
        ?.id,
      source.id,
    );
    const denied = await client.callTool({
      name: "processing_status",
      arguments: { version: 1, scope: "forbidden" },
    });
    assert.ok(denied.isError);
    assert.equal(
      (denied.structuredContent as Record<string, unknown>).embeddings,
      undefined,
    );
  } finally {
    await client.close();
    await service?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
