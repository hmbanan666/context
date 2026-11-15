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
import { protectMcp } from "../src/auth.js";
import { JobStore } from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";
import { fixtureAuth, type ClientGrants } from "./fixtures/auth.js";

const area = "projects";
const resource = "https://context.example/mcp";
const grants: ClientGrants = {
  "token-alpha": {
    read: [area],
    write: [area],
    process: [],
    project: "alpha",
  },
  "token-area": { read: [area], write: [area], process: [] },
};
const createdAt = "2026-10-04T00:00:00Z";
const dates = {
  since: "2026-10-01T00:00:00Z",
  until: "2026-10-08T00:00:00Z",
};
const legacyTools = [
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
];

function body(result: { structuredContent?: unknown }) {
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

test("a project-bound token cannot see or write another project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-project-token-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const jobs = new JobStore(path);
  const auth = fixtureAuth(grants, resource, path);
  const mcp = createContextMcp(sources, [], true, {
    knowledge,
    jobs,
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
  const call = (
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => client.callTool({ name, arguments: args });
  try {
    for (const project of [
      { id: "alpha", name: "Synthetic Alpha", homeArea: area },
      { id: "beta", name: "Synthetic Beta", homeArea: area },
      { id: "gamma", name: "Synthetic Gamma", homeArea: "other" },
      { id: "delta", name: "Synthetic Delta", homeArea: "other" },
    ])
      sources.createProject(project);
    const save = (text: string, scope: string, key: string, project: string) =>
      sources.captureMaterial(
        {
          version: 1,
          scope,
          text,
          origin: "fixture",
          idempotencyKey: key,
          metadata: { createdAt },
        },
        undefined,
        [project],
      ).material.source.id;
    const alphaId = save(
      "Synthetic alpha-lantern sailed at dawn.",
      area,
      "alpha-source",
      "alpha",
    );
    const betaId = save(
      "Synthetic beta-harbor stayed in port.",
      area,
      "beta-source",
      "beta",
    );
    save(
      "Synthetic gamma-keel crossed into the granted area.",
      area,
      "gamma-source",
      "gamma",
    );
    save(
      "Synthetic delta-mist stayed outside.",
      "other",
      "delta-source",
      "delta",
    );
    sources.captureMaterial({
      version: 1,
      scope: area,
      text: "Synthetic loose-anchor has no project.",
      origin: "fixture",
      idempotencyKey: "loose",
      metadata: { createdAt },
    });
    knowledge.addDistilled({
      scope: area,
      sourceId: alphaId,
      kind: "decision",
      text: "Synthetic alpha-lantern remains the bound project.",
      createdAt,
    });
    knowledge.addDistilled({
      scope: area,
      sourceId: betaId,
      kind: "decision",
      text: "Synthetic beta-harbor remains the other project.",
      createdAt,
    });
    const alpha = await connect("token-alpha");
    const areaToken = await connect("token-area");
    const listed = body(await call(alpha, "search", { listProjects: true }));
    assert.deepEqual(listed.projects, [
      { id: "alpha", name: "Synthetic Alpha" },
    ]);
    assert.equal(listed.truncated, false);
    const areaListed = body(
      await call(areaToken, "search", { listProjects: true }),
    );
    assert.deepEqual(
      z
        .array(z.object({ id: z.string() }))
        .parse(areaListed.projects)
        .map((project) => project.id),
      ["alpha", "beta", "gamma"],
    );
    const seen = async (
      client: Client,
      args: Record<string, unknown>,
      phrase: string,
    ) =>
      JSON.stringify(
        (await call(client, "search", args)).structuredContent ?? {},
      ).includes(phrase);
    assert.equal(
      await seen(alpha, { query: "alpha-lantern" }, "alpha-lantern"),
      true,
    );
    assert.equal(
      await seen(alpha, { query: "beta-harbor" }, "beta-harbor"),
      false,
    );
    assert.equal(
      await seen(alpha, { query: "loose-anchor" }, "loose-anchor"),
      false,
    );
    assert.equal(
      await seen(alpha, { query: "gamma-keel" }, "gamma-keel"),
      false,
    );
    assert.equal(
      await seen(alpha, { query: "beta-harbor", ...dates }, "beta-harbor"),
      false,
    );
    assert.equal(
      await seen(alpha, { query: "alpha-lantern", ...dates }, "alpha-lantern"),
      true,
    );
    assert.equal(
      await seen(alpha, { query: "beta-harbor", mode: "pack" }, "beta-harbor"),
      false,
    );
    assert.equal(
      await seen(
        alpha,
        { query: "alpha-lantern", mode: "pack" },
        "alpha-lantern",
      ),
      true,
    );
    const wrongProject = await call(alpha, "search", {
      query: "beta-harbor",
      project: "beta",
    });
    assert.equal(wrongProject.isError, true);
    assert.equal(body(wrongProject).error, "forbidden_project");
    assert.equal(
      JSON.stringify(wrongProject.structuredContent).includes("beta-harbor"),
      false,
    );
    assert.equal(
      await seen(areaToken, { query: "beta-harbor" }, "beta-harbor"),
      true,
    );
    const timeline = JSON.stringify(
      (await call(alpha, "timeline", { limit: 20 })).structuredContent ?? {},
    );
    assert.equal(timeline.includes("alpha-lantern"), true);
    assert.equal(timeline.includes("beta-harbor"), false);
    assert.equal(timeline.includes("loose-anchor"), false);
    const datedTimeline = JSON.stringify(
      (await call(alpha, "timeline", { ...dates, limit: 20 }))
        .structuredContent ?? {},
    );
    assert.equal(datedTimeline.includes("beta-harbor"), false);
    const wrongTimeline = await call(alpha, "timeline", { project: "beta" });
    assert.equal(body(wrongTimeline).error, "forbidden_project");
    const hidden = await call(alpha, "read", { id: betaId });
    assert.equal(hidden.isError, true);
    assert.equal(body(hidden).error, "not_found");
    const visible = body(await call(alpha, "read", { id: alphaId }));
    assert.equal(JSON.stringify(visible).includes("alpha-lantern"), true);
    const remembered = await call(alpha, "remember", {
      text: "Synthetic alpha-lantern follow up.",
      idempotencyKey: "follow",
    });
    assert.equal(remembered.isError, false);
    const followId = z
      .object({ material: z.object({ source: z.object({ id: z.string() }) }) })
      .parse(remembered.structuredContent).material.source.id;
    const follow = body(await call(alpha, "read", { id: followId }));
    assert.ok(
      z
        .array(z.object({ projectId: z.string(), status: z.string() }))
        .parse(follow.associations)
        .some((link) => link.projectId === "alpha" && link.status === "linked"),
    );
    const rejected = await call(alpha, "remember", {
      text: "Synthetic beta-harbor smuggled note.",
      idempotencyKey: "smuggle",
      project: ["beta"],
    });
    assert.equal(body(rejected).error, "forbidden_project");
    assert.equal(
      await seen(areaToken, { query: "smuggled" }, "smuggled"),
      false,
    );
    const mixed = await call(alpha, "remember", {
      text: "Synthetic alpha-lantern and beta-harbor together.",
      idempotencyKey: "mixed",
      project: ["alpha", "beta"],
    });
    assert.equal(body(mixed).error, "forbidden_project");
    for (const name of legacyTools) {
      const result = await call(alpha, name, { id: betaId, query: "harbor" });
      assert.equal(result.isError, true, name);
      assert.equal(body(result).error, "unknown_tool");
      assert.equal(JSON.stringify(result).includes("beta-harbor"), false);
    }
    assert.equal(
      await seen(alpha, { query: "alpha-lantern" }, "alpha-lantern"),
      true,
    );
  } finally {
    for (const client of clients) await client.close();
    await mcp.close();
    jobs.close();
    knowledge.close();
    auth.store.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
