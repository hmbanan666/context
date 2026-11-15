import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { protectMcp } from "../src/auth.js";
import { buildContextPackage } from "../src/context-package.js";
import { importMarkdown } from "../src/import-markdown.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { buildTaskPack } from "../src/task-pack.js";
import { SourceStore } from "../src/store.js";
import { fixtureAuth, type ClientGrants } from "./fixtures/auth.js";

const area = "projects";
const doc = z.object({
  type: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  revision: z.number(),
  setBy: z.string(),
  projectId: z.string(),
});
const savedSchema = z.object({
  material: z.object({
    source: z.object({ id: z.string(), text: z.string() }),
    doc,
  }),
  duplicate: z.boolean(),
});
const readSchema = z.object({
  material: z.object({
    source: z.object({ id: z.string(), text: z.string() }),
    doc,
  }),
  revisions: z.array(
    z.object({
      revision: z.number(),
      id: z.string(),
      status: z.string(),
      setBy: z.string(),
    }),
  ),
});
const searchSchema = z.object({
  sources: z.array(
    z.object({
      id: z.string(),
      doc: z
        .object({ type: z.string(), status: z.string(), revision: z.number() })
        .optional(),
    }),
  ),
});

function body(result: { structuredContent?: unknown }) {
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

async function openSurface() {
  const directory = await mkdtemp(join(tmpdir(), "context-doc-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const mcp = createContextMcp(sources, [area], false, { knowledge });
  const client = new Client({ name: "doc-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  sources.createProject({
    id: "alpha",
    name: "Synthetic Alpha",
    homeArea: area,
  });
  return {
    sources,
    knowledge,
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      return client.callTool({
        name,
        arguments: { scope: area, ...args },
      });
    },
    async close() {
      await client.close();
      await mcp.close();
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("remember writes ADR revisions, read addresses them, and search keeps the latest", async () => {
  const mcp = await openSurface();
  try {
    const names = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["read", "remember", "search", "timeline"]);
    const first = savedSchema.parse(
      (
        await mcp.call("remember", {
          text: "The quartz lantern rule stands.",
          idempotencyKey: "adr-1",
          project: ["alpha"],
          doc: {
            type: "adr",
            key: "adr:0012",
            title: "Lantern rule",
            status: "proposed",
          },
        })
      ).structuredContent,
    );
    assert.equal(first.duplicate, false);
    assert.equal(first.material.doc.revision, 1);
    assert.equal(first.material.doc.setBy, "local");
    assert.equal(first.material.doc.key, "adr:0012");
    const second = savedSchema.parse(
      (
        await mcp.call("remember", {
          text: "The marble lantern rule stands.",
          idempotencyKey: "adr-2",
          project: ["alpha"],
          doc: {
            type: "adr",
            key: "adr:0012",
            title: "Lantern rule",
            status: "accepted",
          },
        })
      ).structuredContent,
    );
    assert.equal(second.material.doc.revision, 2);
    assert.notEqual(second.material.source.id, first.material.source.id);
    const retry = savedSchema.parse(
      (
        await mcp.call("remember", {
          text: "The marble lantern rule stands.",
          idempotencyKey: "adr-2",
          project: ["alpha"],
          doc: {
            type: "adr",
            key: "adr:0012",
            title: "Lantern rule",
            status: "accepted",
          },
        })
      ).structuredContent,
    );
    assert.equal(retry.duplicate, true);
    assert.equal(retry.material.doc.revision, 2);
    const latest = readSchema.parse(
      (await mcp.call("read", { id: "doc:alpha:adr:adr:0012" }))
        .structuredContent,
    );
    assert.match(latest.material.source.text, /marble/);
    assert.equal(latest.material.doc.status, "accepted");
    assert.deepEqual(
      latest.revisions.map((revision) => revision.revision),
      [2, 1],
    );
    assert.equal(latest.revisions[1]?.id, first.material.source.id);
    const older = readSchema.parse(
      (await mcp.call("read", { id: "doc:alpha:adr:adr:0012@1" }))
        .structuredContent,
    );
    assert.match(older.material.source.text, /quartz/);
    assert.equal(older.material.doc.revision, 1);
    assert.equal(
      (await mcp.call("read", { id: "doc:alpha:adr:adr:0012@9" })).isError,
      true,
    );
    const found = searchSchema.parse(
      (await mcp.call("search", { query: "lantern rule", project: "alpha" }))
        .structuredContent,
    );
    assert.deepEqual(
      found.sources.map((source) => source.id),
      [second.material.source.id],
    );
    const buried = searchSchema.parse(
      (await mcp.call("search", { query: "quartz lantern", project: "alpha" }))
        .structuredContent,
    );
    assert.equal(
      buried.sources.some((source) => source.id === first.material.source.id),
      false,
    );
    assert.equal(
      (
        await mcp.call("remember", {
          text: "No project on this document.",
          idempotencyKey: "adr-missing",
          doc: {
            type: "adr",
            key: "missing",
            title: "Missing",
            status: "proposed",
          },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await mcp.call("remember", {
          text: "Wrong status.",
          idempotencyKey: "adr-status",
          project: ["alpha"],
          doc: {
            type: "adr",
            key: "bad",
            title: "Bad",
            status: "active",
          },
        })
      ).isError,
      true,
    );

    const sentence = "The cobalt ledger rule stays in force.";
    const saveRanked = async (
      key: string,
      type: "adr" | "spec",
      status: string,
    ) =>
      savedSchema.parse(
        (
          await mcp.call("remember", {
            text: sentence,
            idempotencyKey: `rank-${key}`,
            project: ["alpha"],
            doc: { type, key, title: key, status },
          })
        ).structuredContent,
      );
    const accepted = await saveRanked("keep", "adr", "accepted");
    const active = await saveRanked("keep-spec", "spec", "active");
    const superseded = await saveRanked("old", "adr", "superseded");
    await mcp.call("remember", {
      text: sentence,
      idempotencyKey: "plain-note",
      project: ["alpha"],
    });
    const ranked = searchSchema.parse(
      (
        await mcp.call("search", {
          query: "cobalt ledger",
          project: "alpha",
        })
      ).structuredContent,
    );
    const ids = ranked.sources.map((source) => source.id);
    const acceptedAt = ids.indexOf(accepted.material.source.id);
    const activeAt = ids.indexOf(active.material.source.id);
    const supersededAt = ids.indexOf(superseded.material.source.id);
    assert.ok(acceptedAt >= 0 && activeAt >= 0 && supersededAt >= 0);
    assert.ok(acceptedAt < supersededAt);
    assert.ok(activeAt < supersededAt);
    const docs = searchSchema.parse(
      (
        await mcp.call("search", {
          query: "cobalt ledger",
          project: "alpha",
          kind: "doc",
        })
      ).structuredContent,
    );
    assert.equal(docs.sources.length, 3);
    assert.equal(
      docs.sources.every((source) => source.doc !== undefined),
      true,
    );
    const adrs = searchSchema.parse(
      (
        await mcp.call("search", {
          query: "cobalt ledger",
          project: "alpha",
          docType: "adr",
        })
      ).structuredContent,
    );
    assert.deepEqual(
      adrs.sources.map((source) => source.id).sort(),
      [accepted.material.source.id, superseded.material.source.id].sort(),
    );
    const pack = z
      .object({ sources: z.array(z.object({ id: z.string() })) })
      .parse(
        (
          await mcp.call("search", {
            query: "cobalt ledger",
            project: "alpha",
            mode: "pack",
          })
        ).structuredContent,
      );
    const packed = pack.sources.map((source) => source.id);
    assert.equal(packed.includes(accepted.material.source.id), true);
    assert.equal(packed.includes(active.material.source.id), true);
    assert.equal(packed.includes(superseded.material.source.id), false);
    const fact = mcp.knowledge.addDistilled({
      scope: area,
      sourceId: accepted.material.source.id,
      kind: "decision",
      text: "The cobalt ledger rule stays in force.",
      createdAt: "2026-01-02T00:00:00.000Z",
      proposedProjectId: "alpha",
    });
    const mixed = z
      .object({
        items: z.array(z.object({ id: z.string(), kind: z.string() })),
      })
      .parse(
        (
          await mcp.call("search", {
            query: "cobalt ledger",
            project: "alpha",
          })
        ).structuredContent,
      );
    assert.equal(
      mixed.items.some(
        (item) => item.id === fact.item.id && item.kind === "decision",
      ),
      true,
    );
    const docsOnly = z
      .object({
        sources: z.array(
          z.object({ id: z.string(), doc: z.unknown().optional() }),
        ),
        items: z.array(z.object({ kind: z.string() })),
      })
      .parse(
        (
          await mcp.call("search", {
            query: "cobalt ledger",
            project: "alpha",
            kind: "doc",
          })
        ).structuredContent,
      );
    assert.equal(docsOnly.items.length, 0);
    assert.equal(docsOnly.sources.length, 3);
    assert.equal(
      docsOnly.sources.every((source) => source.doc !== undefined),
      true,
    );
  } finally {
    await mcp.close();
  }
});

test("a project-bound token cannot read another project's document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-doc-token-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const grants: ClientGrants = {
    "token-alpha": {
      read: [area],
      write: [area],
      process: [],
      project: "alpha",
    },
    "token-beta": {
      read: [area],
      write: [area],
      process: [],
      project: "beta",
    },
  };
  const resource = "https://context.example/mcp";
  const auth = fixtureAuth(grants, resource, path);
  const mcp = createContextMcp(sources, [], true, {
    knowledge,
    auth: auth.store,
  });
  const handler = protectMcp(mcp, auth.config, auth.store);
  const clients: Client[] = [];
  const connect = async (clientId: string) => {
    const token = auth.token(clientId, ["context:read", "context:write", area]);
    const client = new Client({ name: clientId, version: "1" });
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
    sources.createProject({
      id: "alpha",
      name: "Synthetic Alpha",
      homeArea: area,
    });
    sources.createProject({
      id: "beta",
      name: "Synthetic Beta",
      homeArea: area,
    });
    const alpha = await connect("token-alpha");
    const beta = await connect("token-beta");
    const saved = await alpha.callTool({
      name: "remember",
      arguments: {
        scope: area,
        text: "Alpha keeps the violet ledger rule.",
        idempotencyKey: "violet",
        doc: {
          type: "adr",
          key: "violet",
          title: "Violet",
          status: "accepted",
        },
      },
    });
    assert.equal(saved.isError, false, JSON.stringify(saved.structuredContent));
    const written = savedSchema.parse(saved.structuredContent);
    assert.equal(written.material.doc.setBy, "token-alpha");
    assert.equal(written.material.doc.projectId, "alpha");
    const denied = await beta.callTool({
      name: "read",
      arguments: { scope: area, id: "doc:alpha:adr:violet" },
    });
    assert.equal(body(denied).error, "not_found");
    const hidden = searchSchema.parse(
      (
        await beta.callTool({
          name: "search",
          arguments: { scope: area, query: "violet ledger" },
        })
      ).structuredContent,
    );
    assert.equal(hidden.sources.length, 0);
    const crossed = await alpha.callTool({
      name: "remember",
      arguments: {
        scope: area,
        text: "Alpha tries to write beta.",
        idempotencyKey: "cross",
        project: ["beta"],
        doc: {
          type: "adr",
          key: "other",
          title: "Other",
          status: "proposed",
        },
      },
    });
    assert.equal(body(crossed).error, "forbidden_project");
    const own = await alpha.callTool({
      name: "read",
      arguments: { scope: area, id: "doc:alpha:adr:violet" },
    });
    assert.equal(own.isError, false);
    assert.match(
      readSchema.parse(own.structuredContent).material.source.text,
      /violet/,
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await mcp.close();
    auth.store.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("markdown import maps ADR front matter onto document revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-doc-import-"));
  const databasePath = join(directory, "context.db");
  const folder = join(directory, "docs");
  const adr = join(folder, "adr", "0012-keep.md");
  const body = `---
type: adr
key: "0012"
status: accepted
title: Keep the ledger
---

# Keep the ledger

The amber index stays.
`;
  await mkdir(join(folder, "adr"), { recursive: true });
  await mkdir(join(folder, "spec"), { recursive: true });
  await writeFile(adr, body);
  await writeFile(
    join(folder, "adr", "0013-copy.md"),
    body.replace("Keep the ledger", "Copy"),
  );
  await writeFile(
    join(folder, "adr", "0099-bad.md"),
    `---
type: adr
key: "0099"
status: active
title: Wrong
---

# Wrong

Nope.
`,
  );
  await writeFile(
    join(folder, "spec", "ledger.md"),
    `---
type: spec
key: ledger
status: active
title: Ledger spec
---

# Ledger spec

The ledger spec is active.
`,
  );
  await writeFile(
    join(folder, "about.md"),
    "# About\n\nA plain imported note.\n",
  );
  const store = new SourceStore(databasePath);
  const knowledge = new KnowledgeStore(databasePath);
  try {
    store.createProject({
      id: "mira",
      name: "Mira Quill",
      homeArea: "studio",
    });
    const reasons: string[] = [];
    const first = await importMarkdown(
      store,
      folder,
      { areas: ["studio"], area: "studio", project: "mira" },
      (result) => {
        if (result.type === "item" && result.status === "rejected")
          reasons.push(result.reason ?? "");
      },
    );
    assert.equal(first.added, 3);
    assert.equal(first.rejected, 2);
    assert.deepEqual(reasons.sort(), ["duplicate_key", "invalid_front_matter"]);
    const current = store.resolveDocument("doc:mira:adr:0012", "studio");
    assert.ok(current);
    assert.equal(current.material.doc?.status, "accepted");
    assert.equal(current.material.doc?.setBy, "import");
    assert.equal(current.material.doc?.revision, 1);
    assert.equal(current.material.import?.metadata.docKey, "0012");
    await writeFile(
      adr,
      body
        .replace("status: accepted", "status: superseded")
        .replace("stays", "remains"),
    );
    const updated = await importMarkdown(store, folder, {
      areas: ["studio"],
      area: "studio",
      project: "mira",
    });
    assert.equal(updated.updated, 1);
    assert.equal(updated.skipped, 2);
    assert.equal(updated.rejected, 2);
    const latest = store.resolveDocument("doc:mira:adr:0012", "studio");
    const older = store.resolveDocument("doc:mira:adr:0012@1", "studio");
    assert.match(latest?.material.source.text ?? "", /remains/);
    assert.equal(latest?.material.doc?.revision, 2);
    assert.equal(latest?.material.doc?.status, "superseded");
    assert.match(older?.material.source.text ?? "", /stays/);
    assert.equal(older?.material.doc?.revision, 1);
    const found = buildContextPackage(
      store,
      knowledge,
      { version: 1, scope: "studio", question: "amber index", limit: 5 },
      undefined,
      "mira",
    );
    assert.equal(found.sources.length, 1);
    assert.match(found.sources[0]?.excerpt.text ?? "", /remains/);
    const pack = buildTaskPack(store, knowledge, {
      scope: "studio",
      projectId: "mira",
      question: "amber index",
      budgetBytes: 8192,
    });
    assert.equal(
      pack.sources.some((source) => source.id === latest?.material.source.id),
      true,
    );
  } finally {
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
