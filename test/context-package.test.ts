import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import {
  buildContextPackage,
  excerpt,
  knowledgeExcerpt,
} from "../src/context-package.js";
import { VISIBLE_TEXT_VERSION } from "../src/search-lexical.js";
import { visibleSourceText } from "../src/source-text.js";
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
        name: "search",
        arguments: {
          query: question,
          since: period.from,
          until: period.until,
          budgetBytes: 4096,
        },
      });
      assert.ok(!r.isError, JSON.stringify(r));
      const { readMore: _hint, ...rest } = r.structuredContent as Record<
        string,
        unknown
      > & { readMore?: unknown };
      const data = rest as unknown as ReturnType<typeof buildContextPackage>;
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
          name: "read",
          arguments: { scope, id: s.id },
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
      "forbidden",
    ]);
    for (const [client, args] of [
      [noRead, {}],
      [noData, {}],
      [forgedScope, { scope: "forbidden" }],
    ] as const) {
      const r = await client.callTool({
        name: "search",
        arguments: { query: "platinum", ...args },
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
      name: "search",
      arguments: { query: "platinum" },
    });
    assert.ok(!r.isError);
    assert.deepEqual(
      (r.structuredContent as Record<string, unknown>)?.sources,
      [],
    );
    const original = await ordinary.callTool({
      name: "timeline",
      arguments: { since: period.from, until: period.until },
    });
    assert.ok(!original.isError);
  } finally {
    await f.cleanup();
  }
  const disabled = await setup();
  try {
    const { createContextMcp } = await import("../src/mcp.js");
    const mcp = createContextMcp(disabled.store, ["package"], false, {
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
        name: "search",
        arguments: { query: "private" },
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
    // Historical status remains effective after the review-writing experiment is removed.
    const legacy = new DatabaseSync(f.path);
    legacy
      .prepare(`INSERT INTO knowledge_reviews
      (id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
      VALUES (?, ?, ?, 'rejected', 'Fictional legacy rejection', 'fixture', '{}', '2026-10-01T00:00:00Z')`)
      .run("legacy-rejection", rejected.id, scope);
    legacy.close();
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
    const foreign = make("secret", "2026-10-01T12:00:00Z", "forbidden");
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

test("visible source text drops a Cursor pull-request footer and keeps prose", () => {
  const kept = "The lanternquartz hatch seals in the rain.";
  const before = "Before the footer the cobalt mirror was packed.";
  const after =
    "After the footer the dome stayed closed. <div>the hatch notes remain</div>";
  const badge =
    '<div><a href="https://cursor.com/agents/bc-fictional/fictionalfooterxyz"><picture><img alt="Open in Web" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a><a href="https://cursor.com/background-agent?bcId=bc-fictional"><picture><img alt="Open in Cursor" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a></div>';
  const wrapped = `<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n${kept}\n<!-- CURSOR_AGENT_PR_BODY_END -->\n${badge}`;
  assert.equal(visibleSourceText(wrapped), kept);
  assert.equal(visibleSourceText(`${kept}\n${badge}`), kept);
  const around = `${before}\n<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n${kept}\n<!-- CURSOR_AGENT_PR_BODY_END -->\n${badge}\n${after}`;
  const visible = visibleSourceText(around);
  assert.equal(visible.includes(before), true);
  assert.equal(visible.includes(kept), true);
  assert.equal(visible.includes(after), true);
  assert.equal(visible.includes("CURSOR_AGENT_PR_BODY"), false);
  assert.equal(visible.includes("fictionalfooterxyz"), false);
  assert.equal(visible.includes("Open in Web"), false);
  assert.equal(visible.includes("Open in Cursor"), false);
  const greedy = `<picture><source src="https://cursor.com/assets/images/open-in-web-dark.png">${"keptword ".repeat(700)}</picture>`;
  assert.equal(greedy.length > 4000, true);
  assert.equal(visibleSourceText(greedy).includes("keptword"), true);
  const prose =
    "The notes say Open in Cursor when the badge is discussed, then continue with the lanternquartz result.";
  assert.equal(visibleSourceText(prose), prose);
  assert.equal(visibleSourceText(kept), kept);
});

test("a later visible-text fix reindexes body text after a footer once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-footer-version-"));
  const path = join(directory, "db");
  const before = "Before the footer the lanternquartz hatch was open.";
  const after = "After the footer the cobaltpack mirror stayed closed.";
  const badge =
    '<div><a href="https://cursor.com/agents/bc-fictional/fictionalfooterxyz"><picture><img alt="Open in Web" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a></div>';
  const text = `${before}\n<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\nInside the markers.\n<!-- CURSOR_AGENT_PR_BODY_END -->\n${badge}\n${after}`;
  const created = new SourceStore(path);
  const saved = created.capture({
    version: 1,
    text,
    origin: "import:github",
    scope: "personal",
    idempotencyKey: "footer-version",
  }).source;
  created.close();
  const stale = new DatabaseSync(path);
  stale.exec(`
    DELETE FROM sources_fts;
    INSERT INTO sources_fts(rowid, text) SELECT rowid, 'staleindex' FROM sources;
    DELETE FROM sources_stemmed;
    INSERT INTO sources_stemmed(rowid, text)
      SELECT rowid, 'staleindex' FROM sources;
    UPDATE derived_index_meta SET value = '1' WHERE key = 'visible_text';
  `);
  stale.close();
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  try {
    const found = buildContextPackage(sources, knowledge, {
      version: 1,
      scope: "personal",
      question: "cobaltpack",
    });
    assert.equal(found.sources[0]?.id, saved.id);
    assert.equal(found.sources[0]?.excerpt.text.includes("cobaltpack"), true);
    assert.equal(
      buildContextPackage(sources, knowledge, {
        version: 1,
        scope: "personal",
        question: "lanternquartz",
      }).sources[0]?.id,
      saved.id,
    );
    assert.equal(
      found.sources[0]?.excerpt.text.includes("fictionalfooterxyz"),
      false,
    );
    const version = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (
        version
          .prepare(
            "SELECT value FROM derived_index_meta WHERE key = 'visible_text'",
          )
          .get() as { value: string }
      ).value,
      VISIBLE_TEXT_VERSION,
    );
    version.close();
  } finally {
    knowledge.close();
    sources.close();
  }
  const stuck = new DatabaseSync(path);
  stuck.exec(`
    DELETE FROM sources_fts;
    INSERT INTO sources_fts(rowid, text) SELECT rowid, 'staleindex' FROM sources;
    DELETE FROM sources_stemmed;
    INSERT INTO sources_stemmed(rowid, text)
      SELECT rowid, 'staleindex' FROM sources;
  `);
  stuck.close();
  const again = new SourceStore(path);
  const knowledgeAgain = new KnowledgeStore(path);
  try {
    assert.equal(
      buildContextPackage(again, knowledgeAgain, {
        version: 1,
        scope: "personal",
        question: "cobaltpack",
      }).sources.length,
      0,
    );
    assert.equal(again.find(saved.id, "personal")?.text, text);
  } finally {
    knowledgeAgain.close();
    again.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search excerpts omit a stored Cursor pull-request footer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-footer-"));
  const path = join(directory, "db");
  const kept = "The lanternquartz hatch now seals in the rain.";
  const text = `Ship the hatch\n\n<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n${kept}\n<!-- CURSOR_AGENT_PR_BODY_END -->\n<div><a href="https://cursor.com/agents/bc-fictional/fictionalfooterxyz"><picture><img alt="Open in Web" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a><a href="https://cursor.com/background-agent?bcId=bc-fictional"><picture><img alt="Open in Cursor" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a></div>`;
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  try {
    const saved = sources.capture({
      version: 1,
      text,
      origin: "import:github",
      scope: "personal",
      idempotencyKey: "footer",
    }).source;
    const ask = (question: string) =>
      buildContextPackage(sources, knowledge, {
        version: 1,
        scope: "personal",
        question,
      });
    const found = ask("lanternquartz");
    assert.equal(found.sources[0]?.id, saved.id);
    assert.equal(found.sources[0]?.excerpt.text.includes(kept), true);
    assert.equal(
      found.sources[0]?.excerpt.text.includes("fictionalfooterxyz"),
      false,
    );
    assert.equal(
      found.sources[0]?.excerpt.text.includes("Open in Cursor"),
      false,
    );
    assert.equal(
      found.sources[0]?.excerpt.text.includes("CURSOR_AGENT_PR_BODY"),
      false,
    );
    assert.equal(ask("fictionalfooterxyz").sources.length, 0);
    assert.equal(sources.find(saved.id, "personal")?.text, text);
    assert.equal(sources.find(saved.id, "personal")?.checksum, saved.checksum);
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old full-text index drops the footer on open without rewriting the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-footer-legacy-"));
  const path = join(directory, "db");
  const kept = "The lanternquartz hatch now seals in the rain.";
  const text = `${kept}\n<!-- CURSOR_AGENT_PR_BODY_END -->\n<div><a href="https://cursor.com/agents/bc-fictional/fictionalfooterxyz"><picture><img alt="Open in Cursor" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></picture></a></div>`;
  const first = new SourceStore(path);
  first.close();
  const legacy = new DatabaseSync(path);
  legacy.function("context_stem", { deterministic: true }, (value) =>
    String(value ?? ""),
  );
  legacy.function("context_visible_text", { deterministic: true }, (value) =>
    String(value ?? ""),
  );
  const id = "legacy-footer";
  const checksum = createHash("sha256").update(text).digest("hex");
  legacy.exec(`
    DROP TRIGGER IF EXISTS sources_insert;
    DROP TABLE IF EXISTS sources_fts;
    CREATE VIRTUAL TABLE sources_fts USING fts5(
      text, content='sources', content_rowid='rowid'
    );
    CREATE TRIGGER sources_insert AFTER INSERT ON sources BEGIN
      INSERT INTO sources_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  legacy
    .prepare(
      "INSERT INTO sources (id, text, origin, scope, captured_at, checksum, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      text,
      "import:github",
      "personal",
      "2026-10-04T00:00:00Z",
      checksum,
      "unreviewed",
    );
  legacy.exec("INSERT INTO sources_fts(sources_fts) VALUES('rebuild');");
  assert.ok(
    legacy
      .prepare(
        "SELECT 1 FROM sources_fts WHERE sources_fts MATCH 'fictionalfooterxyz'",
      )
      .get(),
  );
  legacy.close();
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  try {
    const found = buildContextPackage(sources, knowledge, {
      version: 1,
      scope: "personal",
      question: "lanternquartz",
    });
    assert.equal(found.sources[0]?.excerpt.text.includes(kept), true);
    assert.equal(
      found.sources[0]?.excerpt.text.includes("fictionalfooterxyz"),
      false,
    );
    assert.equal(
      buildContextPackage(sources, knowledge, {
        version: 1,
        scope: "personal",
        question: "fictionalfooterxyz",
      }).sources.length,
      0,
    );
    assert.equal(sources.find(id, "personal")?.text, text);
    assert.equal(sources.find(id, "personal")?.checksum, checksum);
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("knowledge excerpts start at a sentence boundary and trim the end", () => {
  const text =
    "Alpha stays behind. Beta violetlatch continues past the budget and should stop on a sentence when one fits. Gamma is extra.";
  const whole = knowledgeExcerpt(text, text.indexOf("violetlatch"));
  assert.equal(whole.text.startsWith("Beta violetlatch"), true);
  assert.equal(whole.text.includes("Alpha"), false);
  assert.equal(whole.text.includes("Gamma is extra."), true);
  assert.equal(whole.text.endsWith("."), true);
  assert.equal(whole.text, text.slice(whole.start, whole.end));
  const beta = text.slice(text.indexOf("Beta"), text.indexOf(" Gamma"));
  const cut = knowledgeExcerpt(
    text,
    text.indexOf("violetlatch"),
    beta.length + 6,
  );
  assert.equal(cut.text, beta);
  assert.equal(cut.text.endsWith("."), true);
  assert.equal(cut.text.includes("Gamma"), false);
  assert.equal(cut.text, text.slice(cut.start, cut.end));
  const emoji = "😀 done. Next 😀 violetlatch sentence stays whole.";
  const shifted = knowledgeExcerpt(emoji, emoji.indexOf("violetlatch"), 80);
  assert.equal(shifted.text.startsWith("Next 😀 violetlatch"), true);
  assert.equal(shifted.text, emoji.slice(shifted.start, shifted.end));
});

test("source excerpts stop on a word or sentence boundary", () => {
  const text =
    "Alpha prefix stays behind. The cobalt lantern sits on the brass desk and the rest of this sentence should not be cut mid-word when the window is short.";
  const offset = text.indexOf("lantern");
  const cut = excerpt(text, offset, 48);
  assert.equal(cut.text, text.slice(cut.start, cut.end));
  assert.match(cut.text, /lantern/);
  assert.ok(cut.end < text.length);
  const next = text[cut.end] ?? "";
  const previous = text[cut.end - 1] ?? "";
  assert.ok(
    /\s/u.test(next) || /[.!?…。！？]/u.test(previous),
    JSON.stringify(cut.text),
  );
});

test("Unicode excerpts are exact and never split surrogate pairs", () => {
  const text = `${"😀".repeat(150)}needle ${"🚀".repeat(300)}`;
  const e = excerpt(text, text.indexOf("needle"), 361);
  assert.equal(e.text, text.slice(e.start, e.end));
  assert.ok(e.text.includes("needle"));
  assert.ok(!/[\uD800-\uDFFF]/u.test(e.text));
});

test("case-fold expansion cannot shift source excerpt offsets", () => {
  const text = `${"İ".repeat(500)} needle useful fact`;
  const e = excerpt(text, text.indexOf("needle"));
  assert.ok(e.start >= 0 && e.start <= e.end && e.end <= text.length);
  assert.equal(e.text, text.slice(e.start, e.end));
  assert.ok(e.text.includes("needle useful fact"));
});

for (const [question, prefix, fact] of [
  ["art", "Synthetic departure log. ", "Art exhibition attendance was 73."],
  ["cafe", "Synthetic cafeine log. ", "Café budget was 73."],
  ["istanbul", "İ".repeat(300), "İstanbul budget was 73."],
] as const) {
  test(`source and knowledge excerpts use actual FTS matches for ${question}`, async () => {
    const f = await setup();
    try {
      const text = `${prefix}${"Filler 😀. ".repeat(100)}${fact}`;
      const source = f.store.captureMaterial({
        version: 1,
        scope,
        text,
        origin: "fixture:fts-excerpt",
        idempotencyKey: "original",
      }).material.source;
      const item = f.knowledge.add({
        version: 1,
        scope,
        kind: "observation",
        text,
        sourceRefs: [{ sourceId: source.id }],
        creator: { kind: "model", name: "fixture" },
        idempotencyKey: "derived",
      }).item;
      const client = await f.connect();
      const response = await client.callTool({
        name: "search",
        arguments: { query: question, budgetBytes: 4096 },
      });
      assert.ok(!response.isError);
      const result = response.structuredContent as unknown as ReturnType<
        typeof buildContextPackage
      >;
      assert.equal(result.sources[0]?.id, source.id);
      assert.equal(result.items[0]?.id, item.id);
      for (const card of [result.sources[0], result.items[0]]) {
        assert.ok(card);
        assert.ok(
          card.excerpt.text.includes(fact),
          "The short sole FTS matching fact must fit in its excerpt",
        );
        assert.equal(
          card.excerpt.text,
          text.slice(card.excerpt.start, card.excerpt.end),
        );
      }
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
      assert.deepEqual(f.store.find(source.id, scope), source);
    } finally {
      await f.cleanup();
    }
  });
}

const russianParagraph =
  "В длинном русском абзаце говорится о погоде на набережной и о том, как фонари отражались в тёмной воде до самого утра, пока город ещё спал.";
const englishParagraph =
  "The cobalt lantern was packed in a cedar box before the rain started over the harbor.";

test("bilingual excerpts follow the question script and a monolingual note stays put", () => {
  const text = `${russianParagraph}\n\n${englishParagraph}`;
  const middle = Math.floor(russianParagraph.length / 2);
  const english = excerpt(
    text,
    middle,
    360,
    "Where was the cobalt lantern packed?",
  );
  assert.match(english.text, /cobalt lantern/);
  assert.equal(/\p{Script=Cyrillic}/u.test(english.text), false);
  assert.equal(english.text, text.slice(english.start, english.end));
  assert.equal(english.text.startsWith("The cobalt lantern"), true);
  const russian = excerpt(
    text,
    text.indexOf("cedar"),
    360,
    "Как фонари отражались на набережной?",
  );
  assert.match(russian.text, /фонари/);
  assert.equal(/\p{Script=Latin}/u.test(russian.text), false);
  assert.equal(russian.text, text.slice(russian.start, russian.end));
  const mono = `${"Alpha prefix stays behind. ".repeat(8)}The cobalt lantern sits on the brass desk and the rest of this sentence should not be cut.`;
  const offset = mono.indexOf("lantern");
  assert.deepEqual(
    excerpt(mono, offset, 360, "Where is the cobalt lantern?"),
    excerpt(mono, offset, 360),
  );
  assert.deepEqual(
    knowledgeExcerpt(mono, offset, 120, "Where is the cobalt lantern?"),
    knowledgeExcerpt(mono, offset, 120),
  );
});

test("search excerpts a bilingual note in the question language", async () => {
  const f = await setup();
  try {
    const text = `${russianParagraph}\n\n${englishParagraph}`;
    const source = f.store.captureMaterial({
      version: 1,
      scope,
      text,
      origin: "fixture:bilingual-excerpt",
      idempotencyKey: "bilingual",
    }).material.source;
    const mono = `${"Filler sentence about weather. ".repeat(12)}The lanternquartz sits on the brass desk.`;
    const monoSource = f.store.captureMaterial({
      version: 1,
      scope,
      text: mono,
      origin: "fixture:bilingual-excerpt",
      idempotencyKey: "monolingual",
    }).material.source;
    const client = await f.connect();
    const cards = async (query: string) => {
      const response = await client.callTool({
        name: "search",
        arguments: { query },
      });
      assert.equal(response.isError, false, JSON.stringify(response));
      const body = response.structuredContent as {
        sources?: {
          id: string;
          excerpt: { text: string; start: number; end: number };
        }[];
      };
      return body.sources ?? [];
    };
    const english = (await cards("Where was the cobalt lantern packed?")).find(
      (card) => card.id === source.id,
    );
    assert.ok(english);
    assert.match(english.excerpt.text, /cobalt lantern/);
    assert.equal(/\p{Script=Cyrillic}/u.test(english.excerpt.text), false);
    assert.equal(
      english.excerpt.text,
      text.slice(english.excerpt.start, english.excerpt.end),
    );
    const russian = (await cards("Как фонари отражались на набережной?")).find(
      (card) => card.id === source.id,
    );
    assert.ok(russian);
    assert.match(russian.excerpt.text, /фонари/);
    assert.equal(/\p{Script=Latin}/u.test(russian.excerpt.text), false);
    assert.equal(
      russian.excerpt.text,
      text.slice(russian.excerpt.start, russian.excerpt.end),
    );
    const unchanged = (await cards("Where does lanternquartz sit?")).find(
      (card) => card.id === monoSource.id,
    );
    assert.ok(unchanged);
    assert.equal(
      unchanged.excerpt.text,
      excerpt(mono, mono.indexOf("lanternquartz")).text,
    );
  } finally {
    await f.cleanup();
  }
});

test("search reports integer tookMs and logs phases without the query", async () => {
  const f = await setup();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const query = "lanternquartz timingprobe";
  try {
    f.store.captureMaterial({
      version: 1,
      scope,
      text: "The lanternquartz timingprobe sits on the brass desk.",
      origin: "fixture:search-timing",
      idempotencyKey: "timing",
    });
    const client = await f.connect();
    const response = await client.callTool({
      name: "search",
      arguments: { query },
    });
    assert.equal(response.isError, false, JSON.stringify(response));
    const body = response.structuredContent as { tookMs?: unknown };
    assert.equal(typeof body.tookMs, "number");
    assert.equal(Number.isInteger(body.tookMs), true);
    assert.ok((body.tookMs as number) >= 0);
    const logged = lines
      .map((line) => {
        try {
          return JSON.parse(line) as {
            event?: string;
            tookMs?: unknown;
            embedMs?: unknown;
            retrievalMs?: unknown;
            groundingMs?: unknown;
          };
        } catch {
          return undefined;
        }
      })
      .find((entry) => entry?.event === "search");
    assert.ok(logged);
    assert.equal(logged.tookMs, body.tookMs);
    for (const key of ["embedMs", "retrievalMs", "groundingMs"] as const)
      assert.equal(Number.isInteger(logged[key]), true);
    assert.equal(
      lines.some((line) => line.includes(query)),
      false,
    );
  } finally {
    console.error = original;
    await f.cleanup();
  }
});
