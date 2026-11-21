import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { AuthStore } from "../src/auth-store.js";
import { protectMcp } from "../src/auth.js";
import { distillSources } from "../src/distill.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { profileDocument } from "../src/projects.js";
import { SourceStore } from "../src/store.js";

const area = "projects";
const createdAt = "2026-11-21T12:00:00Z";
const decision = "The cobalt grill stays closed.";
const replacement = "The cobalt grill stays shut.";

function body(result: { structuredContent?: unknown }) {
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

async function openLocal() {
  const directory = await mkdtemp(join(tmpdir(), "context-client-knowledge-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const mcp = createContextMcp(sources, [area], false, { knowledge });
  const client = new Client({ name: "local-owner", version: "1" });
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
  sources.createProject({
    id: "beta",
    name: "Synthetic Beta",
    homeArea: area,
  });
  return {
    path,
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

test("a client statement is searchable immediately and is not distilled again", async () => {
  const mcp = await openLocal();
  try {
    const names = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["read", "remember", "search", "timeline"]);
    const saved = await mcp.call("remember", {
      text: decision,
      idempotencyKey: "grill-closed",
      project: ["alpha"],
      metadata: { kind: "decision", createdAt },
    });
    assert.equal(saved.isError, false, JSON.stringify(saved.structuredContent));
    const first = body(saved);
    const item = z
      .object({
        id: z.string(),
        kind: z.literal("decision"),
        status: z.literal("proposed"),
        createdAt: z.literal(createdAt),
      })
      .parse(first.item);
    const retry = body(
      await mcp.call("remember", {
        text: decision,
        idempotencyKey: "grill-closed",
        project: ["alpha"],
        metadata: { kind: "decision", createdAt },
      }),
    );
    assert.equal(retry.duplicate, true);
    assert.equal((retry.item as { id: string }).id, item.id);
    const read = body(await mcp.call("read", { id: item.id }));
    assert.equal((read.item as { text: string }).text, decision);
    const search = JSON.stringify(
      (await mcp.call("search", { query: "cobalt grill", project: "alpha" }))
        .structuredContent,
    );
    assert.match(search, /cobalt grill stays closed/);
    assert.match(search, /"status":"proposed"/);
    assert.match(search, new RegExp(item.id));
    const pack = JSON.stringify(
      (
        await mcp.call("search", {
          mode: "pack",
          project: "alpha",
          query: "cobalt grill",
          budgetBytes: 8192,
        })
      ).structuredContent,
    );
    assert.match(pack, /cobalt grill stays closed/);
    assert.match(pack, /"mode":"pack"/);
    const timeline = JSON.stringify(
      (await mcp.call("timeline", { project: "alpha", limit: 20 }))
        .structuredContent,
    );
    assert.match(timeline, /cobalt grill stays closed/);
    const tooLong = await mcp.call("remember", {
      text: `The cobalt grill ${"x".repeat(400)}`,
      idempotencyKey: "grill-long",
      project: ["alpha"],
      metadata: { kind: "fact" },
    });
    assert.equal(tooLong.isError, true);
    assert.match(
      JSON.stringify(tooLong.structuredContent),
      /one statement of at most 400 characters/,
    );
    const broken = await mcp.call("remember", {
      text: "The cobalt grill stays closed.\nThe hatch stays open.",
      idempotencyKey: "grill-lines",
      project: ["alpha"],
      metadata: { kind: "fact" },
    });
    assert.equal(broken.isError, true);
    assert.equal(
      JSON.stringify(
        (await mcp.call("timeline", { project: "alpha", limit: 20 }))
          .structuredContent,
      ).includes("grill stays closed.\nThe hatch"),
      false,
    );
    mcp.sources.captureMaterial(
      {
        version: 1,
        scope: area,
        text: "Plain note about the weather vane marker.",
        origin: "fixture",
        idempotencyKey: "plain-note",
        metadata: { createdAt: "2020-01-02T00:00:00Z" },
      },
      undefined,
      ["alpha"],
    );
    const refreshed = mcp.knowledge.refreshJournals({
      areas: [area],
      now: new Date(createdAt),
      timeZone: "UTC",
      dryRun: false,
    });
    assert.equal(refreshed.written, 1);
    const journal = mcp.knowledge
      .list(area, 20)
      .find((row) => row.kind === "journal");
    assert.match(journal?.text ?? "", /cobalt grill stays closed/);
    const db = new DatabaseSync(mcp.path);
    try {
      const asked: unknown[] = [];
      const distilled = await distillSources({
        db,
        knowledge: mcp.knowledge,
        areas: [area],
        dryRun: false,
        llm: {
          model: "synthetic",
          async ask(_instruction, data) {
            asked.push(data);
            return [
              {
                index: 0,
                kind: "fact",
                text: "The weather vane marker was recorded in the yard.",
              },
            ];
          },
        },
        unavailable: false,
        batchSize: 8,
        callCap: 12,
        resumeAfter: null,
        frontiers: null,
      });
      assert.equal(distilled.calls, 1);
      assert.equal(distilled.distilled, 1);
      const payload = JSON.stringify(asked);
      assert.equal(payload.includes("cobalt grill"), false);
      assert.match(payload, /weather vane marker/);
    } finally {
      db.close();
    }
    assert.equal(mcp.knowledge.find(item.id, area)?.status, "proposed");
    const citing = mcp.knowledge
      .list(area, 20)
      .filter(
        (row) =>
          (row.kind === "fact" || row.kind === "decision") &&
          row.sourceRefs.some((ref) => ref.sourceId === firstItemSource(first)),
      );
    assert.equal(citing.length, 1);
  } finally {
    await mcp.close();
  }
});

function firstItemSource(saved: Record<string, unknown>): string {
  const material = z
    .object({ source: z.object({ id: z.string() }) })
    .parse(saved.material);
  return material.source.id;
}

test("a client statement is stored as given and is kept when the language check runs", async () => {
  const mcp = await openLocal();
  try {
    const text =
      "Das Observatorium speichert die Quelle und der Spiegel bleibt geschlossen.";
    const saved = body(
      await mcp.call("remember", {
        text,
        idempotencyKey: "german-statement",
        project: ["alpha"],
        metadata: { kind: "decision", createdAt },
      }),
    );
    const item = z
      .object({ id: z.string(), text: z.string() })
      .parse(saved.item);
    assert.equal(item.text, text);
    const source = mcp.sources.captureMaterial(
      {
        version: 1,
        scope: area,
        text: "The observatory logged the lantern-token.",
        origin: "fixture",
        idempotencyKey: "english-distilled",
        metadata: { createdAt },
      },
      undefined,
      ["alpha"],
    );
    mcp.knowledge.addDistilled({
      scope: area,
      sourceId: source.material.source.id,
      kind: "fact",
      text: "The observatory logged the lantern-token.",
      createdAt,
    });
    const refreshed = mcp.knowledge.refreshJournals({
      areas: [area],
      now: new Date(createdAt),
      timeZone: "UTC",
      dryRun: false,
      env: { CONTEXT_DISTILL_LANGUAGE: "ru" },
    });
    assert.equal(refreshed.written, 1);
    const journal = mcp.knowledge
      .list(area, 20)
      .find((row) => row.kind === "journal");
    assert.match(journal?.text ?? "", /speichert die Quelle/);
    assert.equal(journal?.text.includes("lantern-token"), false);
    assert.equal(mcp.knowledge.find(item.id, area)?.text, text);
  } finally {
    await mcp.close();
  }
});

test("supersede stays inside the project and approval requires mayApprove", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-client-approve-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const resource = "https://context.example/mcp";
  const auth = new AuthStore(path, [area]);
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
  const issue = (
    name: string,
    project: string | undefined,
    mayApprove: boolean,
  ) =>
    auth.createCliToken(
      name,
      {
        read: [area],
        write: [area],
        process: [],
        ...(project ? { project } : {}),
      },
      area,
      86400,
      resource,
      false,
      mayApprove,
    );
  const writer = issue("writer", "alpha", false);
  const approver = issue("approver", "alpha", true);
  const mcp = createContextMcp(sources, [], true, { knowledge, auth });
  const handler = protectMcp(
    mcp,
    {
      resource,
      issuer: "https://context.example",
      areas: [area],
      refreshSeconds: 86400,
      offlineSeconds: 30 * 86400,
    },
    auth,
  );
  const connect = async (token: string) => {
    const client = new Client({ name: "token", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return client;
  };
  const writerClient = await connect(writer.token);
  const approverClient = await connect(approver.token);
  const betaToken = issue("beta-writer", "beta", false);
  const betaClient = await connect(betaToken.token);
  const call = (client: Client, args: Record<string, unknown>) =>
    client.callTool({
      name: "remember",
      arguments: { scope: area, ...args },
    });
  try {
    const listed = auth.listTokens();
    assert.equal(
      listed.find((row) => row.name === "writer")?.mayApprove,
      false,
    );
    assert.equal(
      listed.find((row) => row.name === "approver")?.mayApprove,
      true,
    );
    const denied = await call(writerClient, {
      text: decision,
      idempotencyKey: "writer-approved",
      metadata: { kind: "decision", status: "approved", createdAt },
    });
    assert.equal(denied.isError, true);
    assert.equal(body(denied).error, "forbidden");
    assert.match(String(body(denied).message), /cannot set status approved/);
    assert.equal(
      JSON.stringify(
        (
          await writerClient.callTool({
            name: "timeline",
            arguments: { scope: area, limit: 20 },
          })
        ).structuredContent,
      ).includes("cobalt grill"),
      false,
    );
    const beta = body(
      await betaClient.callTool({
        name: "remember",
        arguments: {
          scope: area,
          text: "The beta harbor stays in port.",
          idempotencyKey: "beta-harbor",
          metadata: { kind: "decision", createdAt },
        },
      }),
    );
    const betaId = z.object({ id: z.string() }).parse(beta.item).id;
    const cross = await call(approverClient, {
      text: "The cobalt grill ignores the other project.",
      idempotencyKey: "cross-project",
      metadata: { kind: "decision", supersedes: [betaId], createdAt },
    });
    assert.equal(cross.isError, true);
    assert.match(String(body(cross).message), /not in this project/);
    const otherProject = await call(approverClient, {
      text: "The cobalt grill writes beta.",
      idempotencyKey: "write-beta",
      project: ["beta"],
      metadata: { kind: "decision", createdAt },
    });
    assert.equal(otherProject.isError, true);
    assert.equal(body(otherProject).error, "forbidden_project");
    const approved = body(
      await call(approverClient, {
        text: decision,
        idempotencyKey: "approver-closed",
        metadata: { kind: "decision", status: "approved", createdAt },
      }),
    );
    const approvedId = z
      .object({ id: z.string(), status: z.literal("approved") })
      .parse(approved.item).id;
    assert.equal(knowledge.find(approvedId, area)?.status, "approved");
    const review = new DatabaseSync(path, { readOnly: true });
    try {
      const row = review
        .prepare(
          "SELECT reviewer, evidence FROM knowledge_reviews WHERE knowledge_id = ?",
        )
        .get(approvedId) as { reviewer: string; evidence: string };
      assert.equal(row.reviewer, "approver");
      const evidence = z
        .object({ setBy: z.string(), tokenId: z.string() })
        .parse(JSON.parse(row.evidence));
      assert.equal(evidence.setBy, "approver");
      assert.equal(evidence.tokenId, approver.id);
    } finally {
      review.close();
    }
    const next = body(
      await call(approverClient, {
        text: replacement,
        idempotencyKey: "approver-shut",
        metadata: {
          kind: "decision",
          status: "approved",
          supersedes: [approvedId],
          createdAt,
        },
      }),
    );
    assert.equal(next.duplicate, false);
    const pack = JSON.stringify(
      (
        await approverClient.callTool({
          name: "search",
          arguments: {
            scope: area,
            mode: "pack",
            query: "cobalt grill",
            budgetBytes: 8192,
          },
        })
      ).structuredContent,
    );
    assert.match(pack, /cobalt grill stays shut/);
    assert.equal(pack.includes(approvedId), false);
    const profileDenied = await call(writerClient, {
      text: "Keep the shutter closed.",
      idempotencyKey: "writer-profile",
      doc: {
        type: "profile",
        key: "profile",
        title: "Track the dome.",
      },
    });
    assert.equal(profileDenied.isError, true);
    assert.equal(body(profileDenied).error, "forbidden");
    assert.equal(sources.profile("alpha"), undefined);
  } finally {
    await writerClient.close();
    await approverClient.close();
    await betaClient.close();
    await mcp.close();
    auth.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a may-approve token sets one project profile and cannot pin another project", async () => {
  const mcp = await openLocal();
  try {
    const decisionSaved = body(
      await mcp.call("remember", {
        text: decision,
        idempotencyKey: "pin-source",
        project: ["alpha"],
        metadata: { kind: "decision", status: "approved", createdAt },
      }),
    );
    const pin = z.object({ id: z.string() }).parse(decisionSaved.item).id;
    const beta = body(
      await mcp.call("remember", {
        text: "The beta harbor stays in port.",
        idempotencyKey: "beta-pin",
        project: ["beta"],
        metadata: { kind: "decision", status: "approved", createdAt },
      }),
    );
    const betaPin = z.object({ id: z.string() }).parse(beta.item).id;
    const saved = body(
      await mcp.call("remember", {
        text: "Keep the shutter closed.",
        idempotencyKey: "alpha-profile",
        project: ["alpha"],
        doc: {
          type: "profile",
          key: "profile",
          title: "Track the dome.",
          pins: [pin],
        },
      }),
    );
    const profile = z
      .object({
        purpose: z.string(),
        rules: z.string(),
        pinned: z.array(z.string()),
        setBy: z.string(),
      })
      .parse(saved.profile);
    assert.equal(profile.purpose, "Track the dome.");
    assert.equal(profile.rules, "Keep the shutter closed.");
    assert.deepEqual(profile.pinned, [pin]);
    assert.equal(profile.setBy, "local");
    assert.equal(
      sourcesProfile(mcp.sources, "alpha")?.purpose,
      "Track the dome.",
    );
    const replaced = body(
      await mcp.call("remember", {
        text: "Keep the shutter locked.",
        idempotencyKey: "alpha-profile-2",
        project: ["alpha"],
        doc: {
          type: "profile",
          key: "other-key",
          title: "Watch the dome.",
          pins: [pin],
        },
      }),
    );
    assert.equal(
      (replaced.profile as { purpose: string }).purpose,
      "Watch the dome.",
    );
    assert.equal(
      mcp.sources.profile("alpha")?.rules,
      "Keep the shutter locked.",
    );
    const foreign = await mcp.call("remember", {
      text: "Keep the shutter closed.",
      idempotencyKey: "foreign-pin",
      project: ["alpha"],
      doc: {
        type: "profile",
        key: "profile",
        title: "Track the dome.",
        pins: [betaPin],
      },
    });
    assert.equal(foreign.isError, true);
    assert.match(String(body(foreign).message), /not a decision/);
    assert.equal(mcp.sources.profile("alpha")?.purpose, "Watch the dome.");
    const purpose = "я".repeat(1023);
    assert.equal(
      Buffer.byteLength(profileDocument(purpose, "x", []), "utf8"),
      2048,
    );
    const tooBig = await mcp.call("remember", {
      text: "xx",
      idempotencyKey: "profile-too-big",
      project: ["alpha"],
      doc: { type: "profile", key: "profile", title: purpose },
    });
    assert.equal(tooBig.isError, true);
    assert.match(String(body(tooBig).message), /2048 UTF-8 bytes/);
    assert.equal(
      mcp.sources.profile("alpha")?.rules,
      "Keep the shutter locked.",
    );
    const db = new DatabaseSync(mcp.path);
    try {
      const asked: unknown[] = [];
      await distillSources({
        db,
        knowledge: mcp.knowledge,
        areas: [area],
        dryRun: false,
        llm: {
          model: "synthetic",
          async ask(_instruction, data) {
            asked.push(data);
            return [];
          },
        },
        unavailable: false,
        batchSize: 8,
        callCap: 12,
        resumeAfter: null,
        frontiers: null,
      });
      const payload = JSON.stringify(asked);
      assert.equal(payload.includes("shutter locked"), false);
      assert.equal(payload.includes("Watch the dome"), false);
    } finally {
      db.close();
    }
  } finally {
    await mcp.close();
  }
});

function sourcesProfile(
  sources: SourceStore,
  projectId: string,
): { purpose?: string } | undefined {
  return sources.profile(projectId);
}

test("token create shows mayApprove and leaves it off by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-may-approve-cli-"));
  const env = {
    ...process.env,
    CONTEXT_AUTH: "oauth",
    CONTEXT_PUBLIC_URL: "https://context.example/mcp",
    CONTEXT_DB_PATH: join(directory, "context.db"),
    CONTEXT_AREAS: "personal",
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
    });
  try {
    const plain = run([
      "token",
      "create",
      "plain-client",
      "--read",
      "personal",
      "--write",
      "personal",
      "--default-write",
      "personal",
    ]);
    assert.equal(plain.status, 0, plain.stderr);
    const trusted = run([
      "token",
      "create",
      "trusted-client",
      "--read",
      "personal",
      "--write",
      "personal",
      "--default-write",
      "personal",
      "--may-approve",
    ]);
    assert.equal(trusted.status, 0, trusted.stderr);
    const listed = z
      .array(
        z.object({
          name: z.string().nullable(),
          mayApprove: z.boolean(),
        }),
      )
      .parse(JSON.parse(run(["token", "list"]).stdout));
    assert.equal(
      listed.find((row) => row.name === "plain-client")?.mayApprove,
      false,
    );
    assert.equal(
      listed.find((row) => row.name === "trusted-client")?.mayApprove,
      true,
    );
    assert.equal(
      run(["token", "list"]).stdout.includes(plain.stdout.trim()),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
