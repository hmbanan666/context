import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { protectMcp } from "../src/auth.js";
import { AuthStore, secret } from "../src/auth-store.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

const area = "studio";
const resource = "https://context.example/mcp";
const saved = z.object({
  material: z.object({ source: z.object({ id: z.string() }) }),
  duplicate: z.boolean(),
  projectCreated: z.boolean().optional(),
});

function body(result: { structuredContent?: unknown }) {
  return z
    .object({
      error: z.string().optional(),
      message: z.string().optional(),
      duplicate: z.boolean().optional(),
      projectCreated: z.boolean().optional(),
      material: z.object({ source: z.object({ id: z.string() }) }).optional(),
    })
    .parse(result.structuredContent ?? {});
}

test("remember creates a project only for an opted-in area token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-remember-project-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const auth = new AuthStore(path, [area, "personal"]);
  sources.createProject({
    id: "alpha",
    name: "Synthetic Alpha",
    homeArea: area,
  });
  sources.createProject({
    id: "kept",
    name: "Kept Name",
    homeArea: "personal",
  });
  const writer = auth.createCliToken(
    "area-writer",
    { read: [area], write: [area], process: [] },
    area,
    86400,
    resource,
    true,
  );
  const plain = auth.createCliToken(
    "area-plain",
    { read: [area], write: [area], process: [] },
    area,
    86400,
    resource,
  );
  const reader = auth.createCliToken(
    "area-reader",
    { read: [area], write: [], process: [] },
    null,
    86400,
    resource,
    true,
  );
  const bound = auth.createCliToken(
    "bound-alpha",
    { read: [area], write: [area], process: [], project: "alpha" },
    area,
    86400,
    resource,
  );
  const registered = auth.register(
    "fictional-oauth",
    ["https://client.example/cb"],
    false,
    "none",
  );
  const oauthClient = auth.client(registered.client.id);
  auth.saveClient({
    ...oauthClient,
    grants: { read: [area], write: [area], process: [] },
    defaultWrite: area,
  });
  const oauth = auth.issue({
    clientId: oauthClient.id,
    kind: "access",
    resource,
    grants: { read: [area], write: [area], process: [] },
    defaultWrite: area,
    scopes: ["context:read", "context:write", area],
    expires: auth.time() + 3600,
    family: secret(),
    familyExpires: auth.time() + 3600,
    createProjects: true,
  });
  const mcp = createContextMcp(sources, [], true, { knowledge, auth });
  const handler = protectMcp(
    mcp,
    {
      resource,
      issuer: "https://context.example",
      areas: [area, "personal"],
      refreshSeconds: 86400,
      offlineSeconds: 30 * 86400,
    },
    auth,
  );
  const clients: Client[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "remember-project", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    try {
      return await client.callTool({
        name,
        arguments: { scope: area, ...args },
      });
    } catch (error) {
      return {
        isError: true,
        structuredContent: {
          error: "invalid_input",
          message: error instanceof Error ? error.message : "Invalid input",
        },
      };
    }
  };
  try {
    assert.equal(
      auth.listTokens().find((row) => row.id === writer.id)?.createProjects,
      true,
    );
    assert.equal(
      auth.listTokens().find((row) => row.id === plain.id)?.createProjects,
      false,
    );
    const writerClient = await connect(writer.token);
    const created = saved.parse(
      (
        await call(writerClient, "remember", {
          text: "Synthetic lantern hangs in the studio.",
          idempotencyKey: "lantern",
          project: ["lantern"],
          projectName: "Fictional Lantern",
        })
      ).structuredContent,
    );
    assert.equal(created.duplicate, false);
    assert.equal(created.projectCreated, true);
    assert.deepEqual(sources.findProject("lantern"), {
      id: "lantern",
      name: "Fictional Lantern",
      homeArea: area,
    });
    assert.deepEqual(
      sources.associationsFor("source", created.material.source.id),
      [{ projectId: "lantern", origin: "client", status: "linked" }],
    );
    const retry = saved.parse(
      (
        await call(writerClient, "remember", {
          text: "Synthetic lantern hangs in the studio.",
          idempotencyKey: "lantern",
          project: ["lantern"],
          projectName: "Other Lantern",
        })
      ).structuredContent,
    );
    assert.equal(retry.duplicate, true);
    assert.equal(retry.projectCreated, false);
    assert.equal(retry.material.source.id, created.material.source.id);
    assert.equal(sources.findProject("lantern")?.name, "Fictional Lantern");
    const again = saved.parse(
      (
        await call(writerClient, "remember", {
          text: "Synthetic lantern gets a second note.",
          idempotencyKey: "lantern-2",
          project: ["lantern"],
          projectName: "Renamed Lantern",
        })
      ).structuredContent,
    );
    assert.equal(again.projectCreated, false);
    assert.equal(sources.findProject("lantern")?.name, "Fictional Lantern");
    const kept = saved.parse(
      (
        await call(writerClient, "remember", {
          text: "Synthetic kept note stays named.",
          idempotencyKey: "kept",
          project: ["kept"],
          projectName: "Renamed Kept",
        })
      ).structuredContent,
    );
    assert.equal(kept.projectCreated, false);
    assert.equal(sources.findProject("kept")?.name, "Kept Name");
    assert.equal(sources.findProject("kept")?.homeArea, "personal");
    const wings = saved.parse(
      (
        await call(writerClient, "remember", {
          text: "Synthetic east and west wings.",
          idempotencyKey: "wings",
          project: ["eastwing", "westwing"],
        })
      ).structuredContent,
    );
    assert.equal(wings.projectCreated, true);
    assert.equal(sources.findProject("eastwing")?.name, "eastwing");
    assert.equal(sources.findProject("westwing")?.homeArea, area);
    const namedPair = body(
      await call(writerClient, "remember", {
        text: "Synthetic name does not apply to two projects.",
        idempotencyKey: "two-names",
        project: ["northwing", "southwing"],
        projectName: "Fictional Wing",
      }),
    );
    assert.equal(namedPair.error, "invalid_input");
    assert.equal(sources.hasProject("northwing"), false);
    assert.equal(sources.hasProject("southwing"), false);
    const ledger = saved.parse(
      (
        await call(writerClient, "remember", {
          text: "Synthetic ledger rule.",
          idempotencyKey: "ledger-doc",
          project: ["ledger"],
          projectName: "Fictional Ledger",
          doc: {
            type: "note",
            key: "rule",
            title: "Rule",
            status: "active",
          },
        })
      ).structuredContent,
    );
    assert.equal(ledger.projectCreated, true);
    assert.equal(sources.findProject("ledger")?.name, "Fictional Ledger");
    const plainClient = await connect(plain.token);
    const plainDenied = body(
      await call(plainClient, "remember", {
        text: "Synthetic plain token must not create a project.",
        idempotencyKey: "plain",
        project: ["plain-project"],
      }),
    );
    assert.equal(plainDenied.error, "unknown_project");
    assert.equal(sources.hasProject("plain-project"), false);
    assert.equal(
      sources.search("plain token must not create", area, 5).length,
      0,
    );
    const readerClient = await connect(reader.token);
    const readDenied = body(
      await call(readerClient, "remember", {
        text: "Synthetic reader must not create a project.",
        idempotencyKey: "reader",
        project: ["reader-project"],
      }),
    );
    assert.equal(readDenied.error, "insufficient_scope");
    assert.equal(sources.hasProject("reader-project"), false);
    const boundClient = await connect(bound.token);
    const smuggle = body(
      await call(boundClient, "remember", {
        text: "Synthetic bound token must not create beta.",
        idempotencyKey: "smuggle",
        project: ["beta"],
      }),
    );
    assert.equal(smuggle.error, "forbidden_project");
    assert.equal(sources.hasProject("beta"), false);
    assert.equal(sources.search("must not create beta", area, 5).length, 0);
    const follow = saved.parse(
      (
        await call(boundClient, "remember", {
          text: "Synthetic alpha follow up.",
          idempotencyKey: "follow",
        })
      ).structuredContent,
    );
    assert.equal(follow.projectCreated, undefined);
    assert.ok(
      sources
        .associationsFor("source", follow.material.source.id)
        .some((link) => link.projectId === "alpha"),
    );
    for (const id of ["Lantern", "bad id", "a".repeat(65), "context:write"]) {
      const invalid = await call(writerClient, "remember", {
        text: `Synthetic invalid id ${id} must not be stored.`,
        idempotencyKey: `invalid-${id.length}`,
        project: [id],
      });
      assert.equal(invalid.isError, true, id);
      const detail = JSON.stringify(invalid.structuredContent ?? invalid);
      assert.match(
        detail,
        /invalid|pattern|too big|OAuth|expected|64/i,
        detail,
      );
    }
    assert.equal(sources.search("must not be stored", area, 5).length, 0);
    assert.equal(
      sources
        .listProjects()
        .projects.some(
          (project) =>
            project.id.length > 64 ||
            ["Lantern", "bad id", "context:write"].includes(project.id),
        ),
      false,
    );
    const oauthClientMcp = await connect(oauth.token);
    const oauthDenied = body(
      await call(oauthClientMcp, "remember", {
        text: "Synthetic oauth token must not create a project.",
        idempotencyKey: "oauth",
        project: ["oauth-project"],
      }),
    );
    assert.equal(oauthDenied.error, "unknown_project");
    assert.equal(sources.hasProject("oauth-project"), false);
    const searched = body(
      await call(writerClient, "search", {
        query: "lantern",
        project: "no-such-project",
      }),
    );
    assert.equal(searched.error, "unknown_project");
    assert.equal(sources.hasProject("no-such-project"), false);
  } finally {
    for (const client of clients) await client.close();
    await mcp.close();
    auth.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function moduleUrl(name: string): string {
  return pathToFileURL(
    fileURLToPath(new URL(`../dist/src/${name}.js`, import.meta.url)),
  ).href;
}

function rememberChild(
  db: string,
  key: string,
  text: string,
  project: string,
  projectName?: string,
) {
  const code = `
    import { SourceStore } from ${JSON.stringify(moduleUrl("store"))};
    import { createContextMcp } from ${JSON.stringify(moduleUrl("mcp"))};
    import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
    const sources = new SourceStore(process.env.CONTEXT_DB);
    const mcp = createContextMcp(sources, ["studio"], false);
    const client = new Client({ name: "race", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }));
    const result = await client.callTool({
      name: "remember",
      arguments: {
        scope: "studio",
        text: process.env.CONTEXT_TEXT,
        idempotencyKey: process.env.CONTEXT_KEY,
        project: [process.env.CONTEXT_PROJECT],
        ...(process.env.CONTEXT_NAME ? { projectName: process.env.CONTEXT_NAME } : {}),
      },
    });
    process.stdout.write(JSON.stringify(result.structuredContent ?? {}));
    await client.close();
    await mcp.close();
    sources.close();
  `;
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: {
        ...process.env,
        CONTEXT_DB: db,
        CONTEXT_KEY: key,
        CONTEXT_TEXT: text,
        CONTEXT_PROJECT: project,
        ...(projectName ? { CONTEXT_NAME: projectName } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("local no-auth remember creates one project for concurrent calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-remember-race-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const mcp = createContextMcp(sources, [area], false);
  const client = new Client({ name: "local-remember", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  try {
    const created = saved.parse(
      (
        await client.callTool({
          name: "remember",
          arguments: {
            scope: area,
            text: "Synthetic porch faces the garden.",
            idempotencyKey: "porch",
            project: ["porch"],
            projectName: "Fictional Porch",
          },
        })
      ).structuredContent,
    );
    assert.equal(created.projectCreated, true);
    assert.deepEqual(sources.findProject("porch"), {
      id: "porch",
      name: "Fictional Porch",
      homeArea: area,
    });
    const again = saved.parse(
      (
        await client.callTool({
          name: "remember",
          arguments: {
            scope: area,
            text: "Synthetic porch gets a second note.",
            idempotencyKey: "porch-2",
            project: ["porch"],
            projectName: "Other Porch",
          },
        })
      ).structuredContent,
    );
    assert.equal(again.projectCreated, false);
    assert.equal(sources.findProject("porch")?.name, "Fictional Porch");
  } finally {
    await client.close();
    await mcp.close();
    sources.close();
  }
  const raced = await Promise.all([
    rememberChild(
      path,
      "gate-east",
      "Synthetic east gate opens.",
      "gate",
      "East Gate",
    ),
    rememberChild(
      path,
      "gate-west",
      "Synthetic west gate opens.",
      "gate",
      "West Gate",
    ),
  ]);
  const same = await Promise.all([
    rememberChild(path, "latch", "Synthetic latch drops once.", "latch"),
    rememberChild(path, "latch", "Synthetic latch drops once.", "latch"),
  ]);
  const check = new SourceStore(path);
  try {
    for (const result of raced) assert.equal(result.status, 0, result.stderr);
    const createdFlags = raced.map(
      (result) =>
        z
          .object({ projectCreated: z.boolean() })
          .parse(JSON.parse(result.stdout)).projectCreated,
    );
    assert.deepEqual(createdFlags.sort(), [false, true]);
    const gate = check.findProject("gate");
    assert.equal(gate?.homeArea, area);
    assert.ok(gate?.name === "East Gate" || gate?.name === "West Gate");
    assert.equal(
      check.listProjects().projects.filter((project) => project.id === "gate")
        .length,
      1,
    );
    for (const result of same) assert.equal(result.status, 0, result.stderr);
    const sameFlags = same.map((result) =>
      z
        .object({ duplicate: z.boolean(), projectCreated: z.boolean() })
        .parse(JSON.parse(result.stdout)),
    );
    assert.equal(sameFlags.filter((row) => row.projectCreated).length, 1);
    assert.equal(sameFlags.filter((row) => row.duplicate).length, 1);
    assert.equal(check.findProject("latch")?.name, "latch");
    assert.equal(
      check.listProjects().projects.filter((project) => project.id === "latch")
        .length,
      1,
    );
  } finally {
    check.close();
    await rm(directory, { recursive: true, force: true });
  }
});
