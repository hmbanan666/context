import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { protectMcp } from "../src/auth.js";
import { importJsonl } from "../src/imports.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { normalizeRepositoryName } from "../src/projects.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";
import { fixtureAuth, type ClientGrants } from "./fixtures/auth.js";

const area = "projects";
const dome = {
  id: "github:fictional-owner/observatory:pr:1",
  text: "The fictional observatory shipped a blue dome.",
  created_at: "2026-10-02T00:00:00Z",
  kind: "pr",
  metadata: { repo: "fictional-owner/observatory", number: "1" },
};
const page = {
  id: "github:fictional-owner/notebook:pr:2",
  text: "The fictional notebook shipped a lined page.",
  created_at: "2026-10-18T00:00:00Z",
  kind: "pr",
  metadata: { repo: "fictional-owner/notebook", number: "2" },
};

async function importLines(
  store: SourceStore,
  lines: readonly unknown[],
  source = "github",
) {
  const results: { status?: string; source_id?: string }[] = [];
  await importJsonl(
    store,
    Readable.from([
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    ]),
    { source, area, areas: ["personal", area, "inbox"] },
    (result) => {
      if (result.type === "item") {
        const item: { status: string; source_id?: string } = {
          status: result.status,
        };
        if (result.source_id) item.source_id = result.source_id;
        results.push(item);
      }
    },
  );
  return results;
}

function body(result: { structuredContent?: unknown }) {
  return result.structuredContent as {
    error?: string;
    message?: string;
    duplicate?: boolean;
    projects?: { id: string; name: string }[];
    truncated?: boolean;
    associations?: {
      projectId?: string;
      origin: string;
      status: string;
      suggestedName?: string;
    }[];
    sources?: {
      id?: string;
      excerpt?: { text: string };
      source?: { text: string };
    }[];
    items?: { excerpt?: { text: string } }[];
    material?: { source: { id: string } };
  };
}
function texts(result: { structuredContent?: unknown }) {
  return (body(result).sources ?? []).map(
    (source) => source.excerpt?.text ?? source.source?.text ?? "",
  );
}

async function openLocal(path: string) {
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const mcp = createContextMcp(sources, ["personal", area], false, {
    knowledge,
  });
  const client = new Client({ name: "project-catalog", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  return {
    sources,
    knowledge,
    client,
    call(name: string, args: Record<string, unknown> = {}) {
      return client.callTool({ name, arguments: { scope: area, ...args } });
    },
    async close() {
      await client.close();
      await mcp.close();
      knowledge.close();
      sources.close();
    },
  };
}

test("two imported repositories in one area filter by project and stay area-wide without it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-projects-"));
  const path = join(directory, "context.db");
  const previous = globalThis.fetch;
  const network: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    network.push(String(input));
    throw new Error("unexpected network");
  }) as typeof fetch;
  const mcp = await openLocal(path);
  try {
    mcp.sources.createProject({
      id: "observatory",
      name: "Fictional Observatory",
      homeArea: "personal",
    });
    mcp.sources.createProject({
      id: "notebook",
      name: "Fictional Notebook",
      homeArea: area,
    });
    mcp.sources.createProject({
      id: area,
      name: "Not the area",
      homeArea: area,
    });
    mcp.sources.mapRepository("fictional-owner/observatory", "observatory");
    mcp.sources.mapRepository("fictional-owner/notebook", "notebook");
    const imported = await importLines(mcp.sources, [dome, page]);
    assert.deepEqual(
      imported.map((item) => item.status),
      ["created", "created"],
    );
    const domeId = imported[0]?.source_id;
    const pageId = imported[1]?.source_id;
    if (!domeId || !pageId) throw new Error("missing imported source");
    assert.deepEqual(mcp.sources.associationsFor("source", domeId), [
      { projectId: "observatory", origin: "configured", status: "linked" },
    ]);
    assert.equal(
      mcp.sources.associationsFor("source", pageId)[0]?.projectId,
      "notebook",
    );
    assert.deepEqual(mcp.sources.backfillProjects(), {
      sources: 2,
      derived: 0,
      changed: 0,
    });

    const both = await mcp.call("search", { query: "shipped" });
    assert.equal(both.isError, false);
    assert.deepEqual(
      texts(both)
        .map(
          (text) => text.includes("blue dome") || text.includes("lined page"),
        )
        .filter(Boolean).length,
      2,
    );
    const one = await mcp.call("search", {
      query: "shipped",
      project: "observatory",
    });
    assert.equal(one.isError, false);
    assert.equal(
      texts(one).some((text) => text.includes("blue dome")),
      true,
    );
    assert.equal(
      texts(one).some((text) => text.includes("lined page")),
      false,
    );
    const omitted = await mcp.call("timeline", {
      since: "2026-10-01T00:00:00Z",
      until: "2026-11-01T00:00:00Z",
    });
    const filtered = await mcp.call("timeline", {
      project: "observatory",
      since: "2026-10-01T00:00:00Z",
      until: "2026-11-01T00:00:00Z",
    });
    assert.equal(texts(omitted).length, 2);
    assert.deepEqual(
      texts(filtered).map((text) => text.includes("lined page")),
      [false],
    );
    const read = await mcp.call("read", { id: domeId });
    assert.deepEqual(body(read).associations, [
      { projectId: "observatory", origin: "configured", status: "linked" },
    ]);
    const unknown = await mcp.call("search", {
      query: "shipped",
      project: "missing-project",
    });
    assert.equal(body(unknown).error, "unknown_project");
    assert.match(body(unknown).message ?? "", /missing-project/);
    assert.equal(JSON.stringify(body(unknown)).includes("blue dome"), false);

    const yard = await mcp.call("remember", {
      text: "A fictional yard sits beside the archive.",
      idempotencyKey: "yard",
      project: [area],
    });
    assert.equal(yard.isError, false);
    const kite = await mcp.call("remember", {
      text: "A fictional kite has no project.",
      idempotencyKey: "kite",
    });
    assert.deepEqual(
      body(await mcp.call("read", { id: body(kite).material?.source.id }))
        .associations,
      [],
    );
    const yardOnly = await mcp.call("search", {
      query: "fictional",
      project: area,
    });
    assert.equal(
      texts(yardOnly).some((text) => text.includes("yard")),
      true,
    );
    assert.equal(
      texts(yardOnly).some((text) => text.includes("kite")),
      false,
    );
    assert.equal(
      texts(yardOnly).some((text) => text.includes("blue dome")),
      false,
    );
    const notAnArea = await mcp.call("search", {
      scope: "observatory",
      query: "shipped",
    });
    assert.equal(notAnArea.isError, true);

    const ordered = await mcp.call("remember", {
      text: "Ordered fictional moons.",
      idempotencyKey: "moons",
      project: ["notebook", "observatory"],
    });
    const retry = await mcp.call("remember", {
      text: "Ordered fictional moons.",
      idempotencyKey: "moons",
      project: ["observatory", "notebook"],
    });
    assert.equal(body(retry).duplicate, true);
    assert.equal(
      body(retry).material?.source.id,
      body(ordered).material?.source.id,
    );
    const moons = await mcp.call("read", {
      id: body(ordered).material?.source.id,
    });
    assert.deepEqual(body(moons).associations, [
      { projectId: "notebook", origin: "client", status: "linked" },
      { projectId: "observatory", origin: "client", status: "linked" },
    ]);
    const conflict = await mcp.call("remember", {
      text: "Ordered fictional moons.",
      idempotencyKey: "moons",
      project: ["observatory"],
    });
    assert.equal(body(conflict).error, "idempotency_conflict");
    const missing = await mcp.call("remember", {
      text: "This fictional marker must not be stored.",
      idempotencyKey: "missing",
      project: ["missing-project"],
    });
    assert.equal(body(missing).error, "unknown_project");
    assert.equal(
      JSON.stringify(body(missing)).includes("must not be stored"),
      false,
    );
    const recovered = await mcp.call("remember", {
      text: "This fictional marker must not be stored.",
      idempotencyKey: "missing",
      project: ["notebook"],
    });
    assert.equal(recovered.isError, false);
    for (let n = 1; n <= 9; n++)
      mcp.sources.createProject({
        id: `slot${n}`,
        name: `Slot ${n}`,
        homeArea: area,
      });
    assert.equal(
      (
        await mcp.call("remember", {
          text: "Nine fictional slots.",
          idempotencyKey: "slots",
          project: Array.from({ length: 9 }, (_, index) => `slot${index + 1}`),
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await mcp.call("remember", {
          text: "Nine fictional slots.",
          idempotencyKey: "slots",
          project: ["slot1", "slot1"],
        })
      ).isError,
      true,
    );
    const eight = await mcp.call("remember", {
      text: "Eight fictional slots.",
      idempotencyKey: "slots",
      project: Array.from({ length: 8 }, (_, index) => `slot${index + 1}`),
    });
    assert.equal(eight.isError, false);
    const file = await mcp.call("remember", {
      idempotencyKey: "file-project",
      project: ["observatory"],
      file: {
        filename: "note.md",
        mediaType: "text/markdown",
        contentBase64: Buffer.from("A fictional filed dome.").toString(
          "base64",
        ),
      },
    });
    assert.equal(file.isError, false);

    const catalog = await mcp.call("search", { listProjects: true });
    assert.equal(catalog.isError, false);
    const listed = body(catalog);
    assert.equal(listed.truncated, false);
    assert.deepEqual(
      listed.projects?.map((project) => project.id),
      [...(listed.projects ?? [])].map((project) => project.id).sort(),
    );
    assert.equal(
      listed.projects?.some(
        (project) =>
          project.id === "observatory" &&
          project.name === "Fictional Observatory",
      ),
      true,
    );
    assert.equal(JSON.stringify(listed).includes("blue dome"), false);
    assert.equal("sources" in (listed as object), false);
    assert.deepEqual(Object.keys(listed.projects?.[0] ?? {}).sort(), [
      "id",
      "name",
    ]);
    assert.equal(
      (await mcp.call("search", { listProjects: true, query: "shipped" }))
        .isError,
      true,
    );
    assert.equal(
      (await mcp.call("search", { listProjects: true, project: "observatory" }))
        .isError,
      true,
    );
    const allowed = await mcp.call("search", {
      listProjects: true,
      k: 1,
      since: "2026-10-01T00:00:00Z",
    });
    assert.equal(allowed.isError, false);

    const loose = await mcp.call("remember", {
      text: "A loose fictional note about lanterns.",
      idempotencyKey: "lanterns",
    });
    const looseId = body(loose).material?.source.id ?? "";
    mcp.sources.proposeProjectLink({
      recordKind: "source",
      recordId: looseId,
      sourceId: looseId,
      suggestedName: "Fictional Lanterns",
    });
    mcp.sources.proposeProjectLink({
      recordKind: "source",
      recordId: looseId,
      sourceId: looseId,
      suggestedName: "Fictional Lanterns",
    });
    mcp.sources.proposeProjectLink({
      recordKind: "source",
      recordId: looseId,
      sourceId: looseId,
      projectId: "observatory",
    });
    const proposal = await mcp.call("read", { id: looseId });
    assert.deepEqual(body(proposal).associations, [
      { projectId: "observatory", origin: "proposed", status: "proposed" },
      {
        origin: "proposed",
        status: "proposed",
        suggestedName: "Fictional Lanterns",
      },
    ]);
    const hidden = await mcp.call("search", {
      query: "lanterns",
      project: "observatory",
    });
    assert.equal(
      texts(hidden).some((text) => text.includes("lanterns")),
      false,
    );
    const visible = await mcp.call("search", { query: "lanterns" });
    assert.equal(
      texts(visible).some((text) => text.includes("lanterns")),
      true,
    );
    const stored = new DatabaseSync(path, { readOnly: true });
    const proposalId = String(
      stored.prepare("SELECT id FROM project_proposals").get()?.id,
    );
    stored.close();
    assert.equal(mcp.sources.hasProject(proposalId), false);
    const rejected = await mcp.call("search", {
      query: "lanterns",
      project: proposalId,
    });
    assert.equal(body(rejected).error, "unknown_project");
    assert.equal(
      (
        await mcp.call("remember", {
          text: "Cannot use a proposal id.",
          idempotencyKey: "proposal-id",
          project: [proposalId],
        })
      ).isError,
      true,
    );
    const before = mcp.sources.listProjects().projects.length;
    mcp.sources.proposeProjectLink({
      recordKind: "source",
      recordId: looseId,
      sourceId: looseId,
      projectId: "observatory",
    });
    assert.equal(mcp.sources.listProjects().projects.length, before);

    const names = (await mcp.client.listTools()).tools;
    assert.deepEqual(names.map((tool) => tool.name).sort(), [
      "read",
      "remember",
      "search",
      "timeline",
    ]);
    const search = names.find((tool) => tool.name === "search");
    const properties = search?.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    assert.equal(
      properties.listProjects?.description,
      "List projects; do not search",
    );
    assert.equal(properties.project?.description, "Project id");
    const rememberTool = names.find((tool) => tool.name === "remember");
    const rememberFields = rememberTool
      ? (rememberTool.inputSchema.properties as {
          project?: { description?: string };
        })
      : undefined;
    assert.equal(
      rememberFields?.project?.description,
      "1–8 existing project ids",
    );
    assert.deepEqual(network, []);

    const grants: ClientGrants = {
      archivist: { read: [area, "personal"], write: [area], process: [] },
      outsider: { read: ["personal"], write: [], process: [] },
    };
    const resource = "https://context.example/mcp";
    const auth = fixtureAuth(grants, resource, path);
    const protectedServer = createContextMcp(mcp.sources, [], true, {
      knowledge: mcp.knowledge,
      auth: auth.store,
    });
    const handler = protectMcp(protectedServer, auth.config, auth.store);
    const connect = async (clientId: string, scopes: string[]) => {
      const token = auth.token(clientId, scopes);
      const client = new Client({ name: clientId, version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => handler.fetch(new Request(input, init)),
        }),
      );
      return client;
    };
    const outsider = await connect("outsider", ["context:read", "personal"]);
    const denied = await outsider.callTool({
      name: "read",
      arguments: { scope: area, id: domeId },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.stringify(denied.structuredContent).includes("blue dome"),
      false,
    );
    assert.equal(
      JSON.stringify(denied.structuredContent).includes("configured"),
      false,
    );
    const otherArea = await outsider.callTool({
      name: "search",
      arguments: { scope: "personal", query: "shipped" },
    });
    assert.equal(
      JSON.stringify(otherArea.structuredContent).includes("blue dome"),
      false,
    );
    const archivist = await connect("archivist", [
      "context:read",
      area,
      "personal",
    ]);
    const allowedRead = await archivist.callTool({
      name: "read",
      arguments: { scope: area, id: domeId },
    });
    assert.equal(
      (allowedRead.structuredContent as { associations?: { origin: string }[] })
        .associations?.[0]?.origin,
      "configured",
    );
    await outsider.close();
    await archivist.close();
    await protectedServer.close();
    auth.store.close();
  } finally {
    globalThis.fetch = previous;
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill replaces configured associations and keeps client and proposed links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-backfill-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  try {
    sources.createProject({
      id: "observatory",
      name: "Fictional Observatory",
      homeArea: area,
    });
    sources.createProject({
      id: "notebook",
      name: "Fictional Notebook",
      homeArea: area,
    });
    sources.createProject({ id: "kept", name: "Kept", homeArea: area });
    sources.mapRepository("fictional-owner/observatory", "observatory");
    const first = await importLines(sources, [dome]);
    const original = first[0]?.source_id ?? "";
    assert.equal(
      sources.associationsFor("source", original)[0]?.projectId,
      "observatory",
    );
    const checksum = sources.find(original, area)?.checksum;
    sources.mapRepository("fictional-owner/observatory", "notebook");
    assert.equal((await importLines(sources, [dome]))[0]?.status, "skipped");
    assert.equal(
      sources.associationsFor("source", original)[0]?.projectId,
      "observatory",
    );
    const revised = await importLines(sources, [
      { ...dome, text: "The fictional observatory shipped a second dome." },
    ]);
    assert.equal(revised[0]?.status, "changed");
    const revision = revised[0]?.source_id ?? "";
    assert.equal(
      sources.associationsFor("source", revision)[0]?.projectId,
      "notebook",
    );
    assert.equal(
      sources.associationsFor("source", original)[0]?.projectId,
      "observatory",
    );
    sources.addClientAssociation("source", original, ["kept"]);
    const item = knowledge.add({
      version: 1,
      scope: area,
      idempotencyKey: "distilled",
      kind: "observation",
      text: "The fictional observatory recorded a distilled sentence.",
      sourceRefs: [{ sourceId: original }],
      creator: { kind: "model", name: "fixture" },
    }).item;
    sources.addClientAssociation("knowledge", item.id, ["kept"]);
    sources.proposeProjectLink({
      recordKind: "knowledge",
      recordId: item.id,
      sourceId: original,
      suggestedName: "Fictional Annex",
    });
    const filled = sources.backfillProjects();
    assert.equal(filled.changed, 2);
    assert.equal(filled.derived, 1);
    assert.deepEqual(sources.associationsFor("source", original), [
      { projectId: "kept", origin: "client", status: "linked" },
      { projectId: "notebook", origin: "configured", status: "linked" },
    ]);
    assert.deepEqual(sources.associationsFor("source", revision), [
      { projectId: "notebook", origin: "configured", status: "linked" },
    ]);
    assert.deepEqual(sources.associationsFor("knowledge", item.id), [
      { projectId: "kept", origin: "client", status: "linked" },
      { projectId: "notebook", origin: "configured", status: "linked" },
      {
        origin: "proposed",
        status: "proposed",
        suggestedName: "Fictional Annex",
      },
    ]);
    assert.equal(sources.find(original, area)?.checksum, checksum);
    assert.deepEqual(sources.backfillProjects(), {
      sources: 2,
      derived: 1,
      changed: 0,
    });
    const unmapped = await importLines(sources, [
      {
        ...page,
        id: "github:fictional-owner/catalog:pr:3",
        metadata: { repo: "fictional-owner/catalog", number: "3" },
      },
    ]);
    const catalog = unmapped[0]?.source_id ?? "";
    assert.deepEqual(sources.associationsFor("source", catalog), []);
    sources.mapRepository("fictional-owner/catalog", "observatory");
    assert.equal(sources.backfillProjects().changed > 0, true);
    assert.equal(
      sources.associationsFor("source", catalog)[0]?.projectId,
      "observatory",
    );
    sources.unmapRepository("fictional-owner/catalog");
    sources.backfillProjects();
    assert.deepEqual(sources.associationsFor("source", catalog), []);
    assert.equal(
      sources.renameProject("observatory", "Renamed").id,
      "observatory",
    );
    assert.equal(
      sources
        .listProjects()
        .projects.find((project) => project.id === "observatory")?.name,
      "Renamed",
    );
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository normalization collapses GitHub forms and keeps other strings", () => {
  for (const input of [
    "https://github.com/Owner/Repo.git",
    "https://github.com/Owner/Repo.git/",
    "http://www.github.com/Owner/Repo/",
    "git@github.com:Owner/Repo.git",
    "ssh://git@github.com/Owner/Repo.git",
    "Owner/Repo",
    "owner/repo",
  ])
    assert.equal(normalizeRepositoryName(input), "owner/repo", input);
  assert.equal(
    normalizeRepositoryName("https://example.org/fictional.git"),
    undefined,
  );
  assert.equal(
    normalizeRepositoryName("https://github.com/owner/repo/pull/1"),
    undefined,
  );
  assert.equal(normalizeRepositoryName("not a repo"), undefined);
});

test("map, import, and backfill match a normalized repository without rewriting the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-repo-norm-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  try {
    sources.createProject({
      id: "observatory",
      name: "Fictional Observatory",
      homeArea: area,
    });
    assert.throws(() => sources.mapRepository("not a repo", "observatory"));
    assert.throws(() =>
      sources.mapRepository("https://example.org/fictional.git", "observatory"),
    );
    assert.equal(
      sources.mapRepository(
        "https://github.com/Fictional-Owner/Observatory.git/",
        "observatory",
      ).repo,
      "fictional-owner/observatory",
    );
    assert.equal(
      sources.mapRepository(
        "git@github.com:Fictional-Owner/Observatory.git",
        "observatory",
      ).repo,
      "fictional-owner/observatory",
    );
    assert.equal(sources.repositoryMappings().length, 1);
    const legacy = new DatabaseSync(path);
    legacy.prepare("DELETE FROM project_repo_mappings").run();
    legacy
      .prepare(
        "INSERT INTO project_repo_mappings (repo, project_id, created_at) VALUES (?, ?, ?)",
      )
      .run(
        "Fictional-Owner/Observatory",
        "observatory",
        "2026-01-01T00:00:00Z",
      );
    legacy.close();
    const imported = await importLines(sources, [
      {
        ...dome,
        id: "github:fictional-owner/observatory:pr:9",
        text: "The fictional observatory shipped a copper dome.",
        metadata: {
          repo: "https://github.com/Fictional-Owner/Observatory.git/",
          number: "9",
        },
      },
    ]);
    const id = imported[0]?.source_id ?? "";
    assert.equal(
      sources.associationsFor("source", id)[0]?.projectId,
      "observatory",
    );
    const material = sources.findMaterial(id, area);
    assert.equal(
      material?.import?.metadata.repo,
      "fictional-owner/observatory",
    );
    const text = material?.source.text;
    const checksum = material?.source.checksum;
    const db = new DatabaseSync(path);
    const stored = JSON.parse(
      String(
        db
          .prepare("SELECT provenance FROM source_imports WHERE source_id = ?")
          .get(id)?.provenance,
      ),
    ) as { metadata: { repo: string } };
    stored.metadata.repo =
      "https://github.com/Fictional-Owner/Observatory.git/";
    db.prepare(
      "UPDATE source_imports SET provenance = ? WHERE source_id = ?",
    ).run(JSON.stringify(stored), id);
    db.prepare("DELETE FROM project_associations WHERE record_id = ?").run(id);
    db.close();
    assert.equal(sources.backfillProjects().changed > 0, true);
    assert.equal(
      sources.associationsFor("source", id)[0]?.projectId,
      "observatory",
    );
    assert.equal(
      sources.associationsFor("source", id)[0]?.origin,
      "configured",
    );
    assert.equal(sources.find(id, area)?.text, text);
    assert.equal(sources.find(id, area)?.checksum, checksum);
    const after = new DatabaseSync(path, { readOnly: true });
    const provenance = JSON.parse(
      String(
        after
          .prepare("SELECT provenance FROM source_imports WHERE source_id = ?")
          .get(id)?.provenance,
      ),
    ) as { metadata: { repo: string } };
    after.close();
    assert.equal(
      provenance.metadata.repo,
      "https://github.com/Fictional-Owner/Observatory.git/",
    );
    const other = await importLines(
      sources,
      [
        {
          id: "codex:fictional",
          text: "A fictional codex note about a non-github checkout.",
          metadata: { repo: "https://example.org/fictional.git" },
        },
      ],
      "codex",
    );
    assert.equal(
      sources.findMaterial(other[0]?.source_id ?? "", area)?.import?.metadata
        .repo,
      "https://example.org/fictional.git",
    );
    sources.unmapRepository("git@github.com:fictional-owner/observatory.git");
    assert.equal(sources.repositoryMappings().length, 0);
  } finally {
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search listProjects caps the catalog at 64 ids and names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-catalog-"));
  const path = join(directory, "context.db");
  const mcp = await openLocal(path);
  try {
    for (let index = 0; index < 65; index++) {
      const id = `p${String(index).padStart(2, "0")}`;
      mcp.sources.createProject({
        id,
        name: `Synthetic ${id}`,
        homeArea: area,
      });
    }
    mcp.sources.capture({
      version: 1,
      scope: area,
      text: "fictional-marker-zeta",
      origin: "fixture",
      idempotencyKey: "marker",
    });
    const listed = body(await mcp.call("search", { listProjects: true }));
    assert.equal(listed.truncated, true);
    assert.equal(listed.projects?.length, 64);
    assert.equal(listed.projects?.[0]?.id, "p00");
    assert.equal(listed.projects?.[63]?.id, "p63");
    assert.equal(
      listed.projects?.some((project) => project.id === "p64"),
      false,
    );
    assert.equal(
      JSON.stringify(listed).includes("fictional-marker-zeta"),
      false,
    );
    assert.equal(mcp.sources.listProjects().projects.length, 65);
  } finally {
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner CLI creates the catalog, maps a repository and backfills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-project-cli-"));
  const path = join(directory, "context.db");
  const env = {
    ...process.env,
    CONTEXT_DB_PATH: path,
    CONTEXT_AREAS: "personal,projects,inbox",
  };
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
      input,
    });
  try {
    const created = run([
      "project",
      "create",
      "--id",
      "observatory",
      "--name",
      "Fictional Observatory",
      "--home",
      "projects",
    ]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).id, "observatory");
    assert.equal(
      run([
        "project",
        "create",
        "--id",
        "observatory",
        "--name",
        "Again",
        "--home",
        "projects",
      ]).status,
      1,
    );
    assert.match(
      run([
        "project",
        "create",
        "--id",
        "observatory",
        "--name",
        "Again",
        "--home",
        "projects",
      ]).stderr,
      /already exists/,
    );
    assert.equal(
      run([
        "project",
        "create",
        "--id",
        "Bad Id",
        "--name",
        "Nope",
        "--home",
        "projects",
      ]).status,
      1,
    );
    assert.match(
      run([
        "project",
        "create",
        "--id",
        "finance",
        "--name",
        "Nope",
        "--home",
        "finance",
      ]).stderr,
      /Unknown area/,
    );
    const renamed = run([
      "project",
      "rename",
      "--id",
      "observatory",
      "--name",
      "Renamed Observatory",
    ]);
    assert.equal(JSON.parse(renamed.stdout).id, "observatory");
    run([
      "project",
      "create",
      "--id",
      "notebook",
      "--name",
      "Fictional Notebook",
      "--home",
      "projects",
    ]);
    const mapped = run([
      "project",
      "map",
      "--repo",
      "fictional-owner/observatory",
      "--project",
      "observatory",
    ]);
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.equal(
      run([
        "project",
        "map",
        "--repo",
        "not a repo",
        "--project",
        "observatory",
      ]).status,
      1,
    );
    assert.equal(
      run([
        "project",
        "map",
        "--repo",
        "fictional-owner/missing",
        "--project",
        "missing-project",
      ]).status,
      1,
    );
    const imported = run(
      ["import", "jsonl", "--source", "github", "--area", "projects"],
      `${JSON.stringify(dome)}\n`,
    );
    assert.equal(imported.status, 0, imported.stderr);
    let store = new SourceStore(path);
    try {
      const sourceId = JSON.parse(
        imported.stdout.split("\n")[0] ?? "",
      ).source_id;
      assert.equal(
        store.associationsFor("source", sourceId)[0]?.projectId,
        "observatory",
      );
    } finally {
      store.close();
    }
    assert.equal(
      run([
        "project",
        "map",
        "--repo",
        "fictional-owner/observatory",
        "--project",
        "notebook",
      ]).status,
      0,
    );
    const filled = run(["project", "backfill"]);
    assert.equal(filled.status, 0, filled.stderr);
    assert.equal(JSON.parse(filled.stdout).changed, 1);
    assert.equal(JSON.parse(run(["project", "backfill"]).stdout).changed, 0);
    store = new SourceStore(path);
    try {
      const associations = store.associationsFor(
        "source",
        JSON.parse(imported.stdout.split("\n")[0] ?? "").source_id,
      );
      assert.equal(associations[0]?.projectId, "notebook");
      assert.equal(associations[0]?.origin, "configured");
    } finally {
      store.close();
    }
    const list = JSON.parse(run(["project", "list"]).stdout);
    assert.equal(list.projects[0].homeArea, "projects");
    assert.equal(list.mappings[0].repo, "fictional-owner/observatory");
    assert.equal(
      run(["project", "unmap", "--repo", "fictional-owner/observatory"]).status,
      0,
    );
    assert.equal(
      JSON.parse(run(["project", "list"]).stdout).mappings.length,
      0,
    );
    assert.match(run(["project", "approve"]).stderr, /Usage/);
    assert.equal(run(["project", "approve"]).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
