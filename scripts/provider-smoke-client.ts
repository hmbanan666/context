import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { ClientGrants } from "../src/access.js";
import { createTokenVerifier, protectMcp } from "../src/auth.js";
import { JobStore } from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const {
  issuer,
  accessToken,
  ownerSubject,
  missingProjectToken,
  missingProcessToken,
} = z
  .strictObject({
    issuer: z.url(),
    accessToken: z.string(),
    ownerSubject: z.uuid().default("00000000-0000-4000-8000-000000000001"),
    missingProjectToken: z.string().optional(),
    missingProcessToken: z.string().optional(),
  })
  .parse(JSON.parse(input));
const resource = "https://context.kosarev.space/mcp";
const store = new SourceStore(":memory:");
const mcp = createContextMcp(store, [], true);
const protectedMcp = protectMcp(mcp, {
  issuer,
  resource,
  ownerSubject,
});
const client = new Client({
  name: "synthetic-keycloak-proof",
  version: "1.0.0",
});
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      fetch: async (request, init) =>
        protectedMcp.fetch(new Request(request, init)),
    }),
  );
  const captured = await client.callTool({
    name: "capture",
    arguments: {
      version: 1,
      scope: "synthetic:hosted-pilot",
      text: "Synthetic Keycloak green kite",
      origin: "fixture:real-keycloak",
      idempotencyKey: "keycloak-001",
    },
  });
  assert.ok(!captured.isError);
  const { source } = z
    .object({ source: z.record(z.string(), z.unknown()) })
    .parse(captured.structuredContent);
  const recalled = await client.callTool({
    name: "recall",
    arguments: { version: 1, scope: "synthetic:hosted-pilot", id: source.id },
  });
  assert.deepEqual(
    z
      .object({ sources: z.array(z.unknown()) })
      .parse(recalled.structuredContent).sources,
    [source],
  );
  console.log(
    "Real Keycloak JWKS verification and protected MCP capture/recall: passed",
  );
} finally {
  await client.close();
  await mcp.close();
  store.close();
}

const projectA = "synthetic:project-a";
const projectB = "synthetic:project-b";
const pilot = "synthetic:hosted-pilot";
const grants: ClientGrants = {
  "context-codex": {
    read: [pilot, projectA],
    write: [pilot, projectA],
    process: [projectA],
  },
  "context-chatgpt": {
    read: [pilot, projectA, projectB],
    write: [pilot, projectA],
    process: [projectA],
  },
};
const directory = await mkdtemp(join(tmpdir(), "context-provider-project-"));
const database = join(directory, "context.db");
const sources = new SourceStore(database);
const knowledge = new KnowledgeStore(database);
const jobs = new JobStore(database);
const projectMcp = createContextMcp(sources, [], true, {
  knowledge,
  jobs,
  clientGrants: grants,
});
const config = {
  issuer,
  resource,
  ownerSubject,
  clientGrants: grants,
};
const handler = protectMcp(projectMcp, config);
const clients: Client[] = [];

async function connect(token: string) {
  const client = new Client({
    name: "synthetic-keycloak-project-proof",
    version: "1.0.0",
  });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (request, init) => handler.fetch(new Request(request, init)),
    }),
  );
  return client;
}

try {
  const identity =
    await createTokenVerifier(config).verifyAccessToken(accessToken);
  for (const scope of ["context:process", projectA, projectB])
    assert.ok(identity.scopes.includes(scope));
  const client = await connect(accessToken);
  const foreign = sources.capture({
    version: 1,
    scope: projectB,
    text: "Synthetic project B silver observatory",
    origin: "fixture:real-keycloak-project-b",
    idempotencyKey: "project-b-source",
  }).source;
  const materialResult = await client.callTool({
    name: "capture_material",
    arguments: {
      version: 1,
      scope: projectA,
      text: "Synthetic project A paper observatory",
      origin: "fixture:real-keycloak-project-a",
      idempotencyKey: "project-a-source",
      metadata: { title: "Synthetic project A" },
    },
  });
  assert.ok(!materialResult.isError);
  const material = z
    .object({ material: z.object({ source: z.object({ id: z.string() }) }) })
    .parse(materialResult.structuredContent).material;
  const added = await client.callTool({
    name: "add_knowledge",
    arguments: {
      version: 1,
      scope: projectA,
      idempotencyKey: "project-a-idea",
      kind: "idea",
      text: "A paper observatory for synthetic project A",
      sourceRefs: [
        { sourceId: material.source.id, quote: "paper observatory" },
      ],
      creator: { kind: "model", name: "synthetic-provider-smoke" },
    },
  });
  assert.ok(!added.isError);
  const context = await client.callTool({
    name: "project_context",
    arguments: { version: 1, scope: projectA },
  });
  assert.ok(!context.isError);
  z.object({
    scope: z.literal(projectA),
    items: z.array(z.object({ status: z.literal("suggested") })).length(1),
  }).parse(context.structuredContent);
  assert.equal(JSON.stringify(context).includes(foreign.text), false);
  const queued = await client.callTool({
    name: "queue_processing",
    arguments: {
      version: 1,
      scope: projectA,
      sourceId: material.source.id,
      idempotencyKey: "project-a-job",
    },
  });
  assert.ok(!queued.isError);
  assert.equal(jobs.list(projectA).length, 1);
  for (const request of [
    {
      name: "recall",
      arguments: { version: 1, scope: projectB, id: foreign.id },
    },
    {
      name: "recall",
      arguments: { version: 1, scope: projectB, query: "silver observatory" },
    },
    { name: "project_context", arguments: { version: 1, scope: projectB } },
  ]) {
    const result = await client.callTool(request);
    if (identity.clientId === "context-codex") {
      assert.equal(result.isError, true);
      z.object({ error: z.literal("forbidden_scope") }).parse(
        result.structuredContent,
      );
      assert.equal(JSON.stringify(result).includes(foreign.text), false);
    } else assert.ok(!result.isError);
  }
  const forbiddenWrite = await client.callTool({
    name: "capture",
    arguments: {
      version: 1,
      scope: projectB,
      text: "Synthetic forbidden project B write",
      origin: "fixture:real-keycloak-project-b",
      idempotencyKey: "forbidden-write",
    },
  });
  assert.equal(forbiddenWrite.isError, true);
  assert.equal(sources.list(projectB).length, 1);
  console.log(
    "Real Keycloak project material/knowledge/context/queue and independent client grants: passed",
  );

  if (missingProjectToken !== undefined) {
    const reduced = await connect(missingProjectToken);
    for (const request of [
      {
        name: "recall",
        arguments: { version: 1, scope: projectA, id: material.source.id },
      },
      { name: "project_context", arguments: { version: 1, scope: projectA } },
    ]) {
      const result = await reduced.callTool(request);
      assert.equal(result.isError, true);
      assert.equal(JSON.stringify(result).includes("paper observatory"), false);
    }
  }
  if (missingProcessToken !== undefined) {
    const reduced = await connect(missingProcessToken);
    const denied = await reduced.callTool({
      name: "queue_processing",
      arguments: {
        version: 1,
        scope: projectA,
        sourceId: material.source.id,
        idempotencyKey: "missing-process-job",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(jobs.list(projectA).length, 1);
  }
  if (missingProjectToken !== undefined || missingProcessToken !== undefined)
    console.log(
      "Real Keycloak missing project and processing scopes fail closed: passed",
    );
} finally {
  for (const client of clients) await client.close();
  await projectMcp.close();
  jobs.close();
  knowledge.close();
  sources.close();
  await rm(directory, { recursive: true, force: true });
}
