import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { test } from "vite-plus/test";
import { AuthStore } from "../src/auth-store.js";
import { protectMcp } from "../src/auth.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("help, remember, status, project ids and token names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-agent-memory-"));
  const databasePath = join(directory, "context.db");
  const env = {
    ...process.env,
    CONTEXT_AUTH: "oauth",
    CONTEXT_PUBLIC_URL: "https://context.example/mcp",
    CONTEXT_DB_PATH: databasePath,
    CONTEXT_AREAS: "personal,studio",
  };
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
      ...(input ? { input } : {}),
    });
  try {
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /remember \[--area/);
    assert.match(help.stdout, /token revoke --name/);
    assert.match(help.stdout, / {2}status/);
    const unknown = run(["not-a-command"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /remember \[--area/);
    assert.equal(unknown.stderr.includes("Context command failed"), false);
    const { CONTEXT_PUBLIC_URL: _url, CONTEXT_AUTH: _auth, ...bare } = env;
    const noUrl = spawnSync(
      process.execPath,
      ["dist/scripts/context.js", "token", "list"],
      { env: bare, encoding: "utf8" },
    );
    assert.equal(noUrl.status, 1);
    assert.match(noUrl.stderr, /CONTEXT_PUBLIC_URL/);
    const created = run([
      "project",
      "create",
      "--id",
      "studio-notes",
      "--name",
      "Studio notes",
      "--home",
      "studio",
    ]);
    assert.equal(created.status, 0, created.stderr);
    const dotted = run([
      "project",
      "create",
      "--id",
      "studio.notes",
      "--name",
      "Dotted",
      "--home",
      "studio",
    ]);
    assert.equal(dotted.status, 1);
    assert.match(dotted.stderr, /Dots are not allowed/);
    assert.match(dotted.stderr, /studio-notes/);
    assert.match(dotted.stderr, /studio-notes/);
    const remembered = run([
      "remember",
      "--area",
      "studio",
      "--project",
      "studio-notes",
      "--kind",
      "note",
      "The cobalt lantern key is sk-syntheticsecretvalue and the desk is brass.",
    ]);
    assert.equal(remembered.status, 0, remembered.stderr);
    const saved = JSON.parse(remembered.stdout) as {
      id: string;
      duplicate: boolean;
      scope: string;
      projects: string[];
    };
    assert.equal(saved.duplicate, false);
    assert.equal(saved.scope, "studio");
    assert.deepEqual(saved.projects, ["studio-notes"]);
    assert.equal(remembered.stdout.includes("sk-syntheticsecretvalue"), false);
    const retry = run([
      "remember",
      "--area",
      "studio",
      "--project",
      "studio-notes",
      "The cobalt lantern key is sk-syntheticsecretvalue and the desk is brass.",
    ]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).duplicate, true);
    assert.equal(JSON.parse(retry.stdout).id, saved.id);
    const piped = run(
      ["remember", "--area", "personal"],
      "A piped note about the quiet reading room.\n",
    );
    assert.equal(piped.status, 0, piped.stderr);
    const opened = new SourceStore(databasePath);
    try {
      const material = opened.findMaterial(saved.id, "studio");
      assert.ok(material);
      assert.equal(material.source.origin, "cli:owner");
      assert.equal(
        material.source.text.includes("sk-syntheticsecretvalue"),
        false,
      );
      assert.match(material.source.text, /brass/);
      assert.equal(material.metadata.type, "note");
    } finally {
      opened.close();
    }
    const status = run(["status"]);
    assert.equal(status.status, 0, status.stderr);
    const counts = JSON.parse(status.stdout) as {
      sources: { active: number; retired: number };
      docs: number;
      knowledgeItems: number;
      tokens: number;
      projects: number;
      processor: string;
    };
    assert.equal(counts.sources.active, 2);
    assert.equal(counts.sources.retired, 0);
    assert.equal(counts.docs, 0);
    assert.equal(counts.knowledgeItems, 0);
    assert.equal(counts.projects, 1);
    assert.equal(counts.processor, "off");
    assert.equal(counts.tokens, 0);
    const owner = run(["owner", "init"], "fictional CLI password 123\n");
    assert.equal(owner.status, 0, owner.stderr);
    const token = run([
      "token",
      "create",
      "fictional-worker",
      "--read",
      "studio",
      "--write",
      "studio",
      "--default-write",
      "studio",
    ]);
    assert.equal(token.status, 0, token.stderr);
    const listed = JSON.parse(run(["token", "list"]).stdout) as {
      name: string | null;
      used: boolean;
      id: string;
    }[];
    assert.equal(listed[0]?.name, "fictional-worker");
    assert.equal(listed[0]?.used, false);
    const revoked = run(["token", "revoke", "--name", "fictional-worker"]);
    assert.equal(revoked.status, 0, revoked.stderr);
    const after = JSON.parse(run(["token", "list"]).stdout) as {
      name: string | null;
      revoked: boolean;
    }[];
    assert.equal(after[0]?.revoked, true);
    const missingName = run(["token", "revoke", "--name", "nobody"]);
    assert.equal(missingName.status, 1);
    assert.match(missingName.stderr, /Unknown token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a successful remember marks the token used", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-token-used-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const resource = "https://context.example/mcp";
  const auth = new AuthStore(path, ["personal"]);
  const issued = auth.createCliToken(
    "fictional-worker",
    { read: ["personal"], write: ["personal"], process: [] },
    "personal",
    86400,
    resource,
  );
  const mcp = createContextMcp(sources, [], true, { knowledge, auth });
  const handler = protectMcp(
    mcp,
    {
      resource,
      issuer: "https://context.example",
      areas: ["personal"],
      refreshSeconds: 86400,
      offlineSeconds: 30 * 86400,
    },
    auth,
  );
  const client = new Client({ name: "remember-use", version: "1" });
  try {
    assert.equal(auth.listTokens()[0]?.used, false);
    assert.equal(auth.listTokens()[0]?.lastUsed, null);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    const saved = await client.callTool({
      name: "remember",
      arguments: {
        scope: "personal",
        text: "The fictional worker stored a brass desk note.",
        idempotencyKey: "brass-desk",
      },
    });
    assert.equal(saved.isError, false, JSON.stringify(saved.structuredContent));
    const listed = auth.listTokens().find((row) => row.id === issued.id);
    assert.equal(listed?.name, "fictional-worker");
    assert.equal(listed?.used, true);
    assert.equal(typeof listed?.lastUsed, "number");
    const clientRow = auth
      .listClients()
      .find((row) => row.name === "fictional-worker");
    assert.equal(typeof clientRow?.lastUsed, "number");
  } finally {
    await client.close();
    await mcp.close();
    auth.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
