import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import {
  InvalidPin,
  profileByteLimit,
  profileDocument,
  ProfileTooLarge,
} from "../src/projects.js";
import { SourceStore } from "../src/store.js";
import { runTidy } from "../src/tidy.js";

const scope = "workshop";

async function open(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `context-${name}-`));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  sources.createProject({
    id: "observatory",
    name: "Observatory",
    homeArea: scope,
  });
  return {
    directory,
    path,
    sources,
    knowledge,
    async close() {
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function decision(
  knowledge: KnowledgeStore,
  sources: SourceStore,
  key: string,
  text: string,
) {
  const source = sources.captureMaterial(
    {
      version: 1,
      scope,
      origin: "synthetic:profile",
      idempotencyKey: key,
      text: `Source for ${key}.`,
      metadata: { createdAt: "2026-10-08T00:00:00.000Z" },
    },
    undefined,
    ["observatory"],
  ).material.source;
  return knowledge.addDistilled({
    scope,
    sourceId: source.id,
    kind: "decision",
    text,
    createdAt: "2026-10-08T00:00:00.000Z",
  }).item;
}

test("profile document rejects more than 2048 UTF-8 bytes and keeps pins", async () => {
  const f = await open("profile-bytes");
  try {
    const pinned = decision(
      f.knowledge,
      f.sources,
      "shutter",
      "Dome motors stay disabled until the shutter is confirmed closed.",
    );
    const purpose = "я".repeat(1023);
    assert.equal(
      Buffer.byteLength(profileDocument(purpose, "x", []), "utf8"),
      profileByteLimit,
    );
    const saved = f.sources.setProfile({
      projectId: "observatory",
      purpose,
      rules: "x",
    });
    assert.deepEqual(saved.pinned, []);
    assert.throws(
      () =>
        f.sources.setProfile({
          projectId: "observatory",
          purpose,
          rules: "xx",
        }),
      ProfileTooLarge,
    );
    assert.equal(f.sources.profile("observatory")?.rules, "x");
    const pinnedProfile = f.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the dome.",
      rules: "Keep the shutter closed.",
      pinned: [pinned.id],
    });
    assert.deepEqual(pinnedProfile.pinned, [pinned.id]);
    assert.deepEqual(pinnedProfile.inForce, []);
    assert.throws(
      () =>
        f.sources.setProfile({
          projectId: "observatory",
          purpose: "Track the dome.",
          rules: "Keep the shutter closed.",
          pinned: [pinned.id, pinned.id],
        }),
      /Duplicate pinned decision/,
    );
    const fact = f.knowledge.addDistilled({
      scope,
      sourceId: f.sources.captureMaterial(
        {
          version: 1,
          scope,
          origin: "synthetic:profile",
          idempotencyKey: "fact-source",
          text: "A fact source.",
          metadata: { createdAt: "2026-10-08T00:00:00.000Z" },
        },
        undefined,
        ["observatory"],
      ).material.source.id,
      kind: "fact",
      text: "The shutter sensor reports open or closed.",
      createdAt: "2026-10-08T00:00:00.000Z",
    }).item;
    assert.throws(
      () =>
        f.sources.setProfile({
          projectId: "observatory",
          purpose: "Track the dome.",
          rules: "Keep the shutter closed.",
          pinned: [fact.id],
        }),
      InvalidPin,
    );
    assert.throws(() =>
      f.sources.setProfile({
        projectId: "observatory",
        purpose: "Track the dome.",
        rules: "Keep the shutter closed.",
        pinned: Array.from({ length: 9 }, (_, index) => `pin-${index}`),
      }),
    );
    assert.deepEqual(f.sources.profile("observatory")?.pinned, [pinned.id]);
  } finally {
    await f.close();
  }
});

test("a proposed pin is stored and becomes in force only after approval", async () => {
  const f = await open("profile-force");
  try {
    const pinned = decision(
      f.knowledge,
      f.sources,
      "motors",
      "Dome motors stay disabled until the shutter is confirmed closed.",
    );
    f.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the fictional observatory dome.",
      rules: "Do not move the dome while the shutter is open.",
      pinned: [pinned.id],
    });
    assert.deepEqual(f.sources.profile("observatory")?.inForce, []);
    const dbPath = f.path;
    const { DatabaseSync } = await import("node:sqlite");
    const reviewsDb = new DatabaseSync(dbPath);
    reviewsDb
      .prepare(
        `INSERT INTO knowledge_reviews
          (id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
         VALUES (?, ?, ?, 'approved', '[]', '{"kind":"user","name":"fixture"}', '{}', ?)`,
      )
      .run("approve-motors", pinned.id, scope, "2026-10-21T00:00:00.000Z");
    reviewsDb.close();
    const approved = f.sources.profile("observatory");
    assert.deepEqual(approved?.inForce, [
      {
        id: pinned.id,
        text: "Dome motors stay disabled until the shutter is confirmed closed.",
      },
    ]);
    const newer = f.sources.captureMaterial(
      {
        version: 1,
        scope,
        origin: "synthetic:profile",
        idempotencyKey: "newer",
        text: "A later note.",
        metadata: { createdAt: "2026-10-22T00:00:00.000Z" },
      },
      undefined,
      ["observatory"],
    ).material.source;
    const replacement = f.knowledge.addDistilled({
      scope,
      sourceId: newer.id,
      kind: "decision",
      text: "The dome may move after the shutter is confirmed closed.",
      createdAt: "2026-10-22T00:00:00.000Z",
    }).item;
    f.knowledge.relate({
      version: 1,
      scope,
      idempotencyKey: "supersede-motors",
      kind: "supersedes",
      fromId: replacement.id,
      toId: pinned.id,
      sourceRefs: [{ sourceId: newer.id }],
      creator: { kind: "user", name: "fixture" },
    });
    assert.deepEqual(f.sources.profile("observatory")?.pinned, [pinned.id]);
    assert.deepEqual(f.sources.profile("observatory")?.inForce, []);
    f.sources.clearProfile("observatory");
    assert.equal(f.sources.profile("observatory"), undefined);
  } finally {
    await f.close();
  }
});

test("the processor cannot write or replace a profile", async () => {
  const f = await open("profile-processor");
  try {
    const purpose = "Track the fictional observatory dome.";
    f.sources.setProfile({
      projectId: "observatory",
      purpose,
      rules: "Keep the shutter closed.",
    });
    const source = f.sources.captureMaterial(
      {
        version: 1,
        scope,
        origin: "synthetic:profile",
        idempotencyKey: "mirror",
        text: "Ship the cobalt mirror\n\nA short fictional body.",
        metadata: {
          title: "Ship the cobalt mirror",
          createdAt: "2026-11-11T00:00:00.000Z",
        },
      },
      undefined,
      ["observatory"],
    ).material.source;
    let calls = 0;
    const run = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now: new Date("2026-11-11T12:00:00.000Z"),
      timeZone: "UTC",
      llm: {
        model: "fake",
        async ask() {
          calls++;
          return [
            {
              index: 0,
              kind: "decision",
              text: "In November 2026 the observatory project kept the cobalt mirror.",
              project: null,
              purpose: "hijacked purpose",
              rules: "hijacked rules",
              status: "approved",
            },
          ];
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(run.distilled, 1);
    assert.equal(f.sources.profile("observatory")?.purpose, purpose);
    assert.equal(
      f.sources.profile("observatory")?.rules,
      "Keep the shutter closed.",
    );
    assert.equal(
      f.knowledge.find(
        f.knowledge.list(scope, 20).find((item) => item.kind === "decision")
          ?.id ?? "",
        scope,
      )?.status,
      "proposed",
    );
    assert.equal(source.checksum, f.sources.find(source.id, scope)?.checksum);
  } finally {
    await f.close();
  }
});

test("owner CLI sets, shows and clears a profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-profile-cli-"));
  const path = join(directory, "context.db");
  const env = {
    ...process.env,
    CONTEXT_DB_PATH: path,
    CONTEXT_AREAS: "personal,workshop",
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
    });
  try {
    assert.equal(
      run([
        "project",
        "create",
        "--id",
        "observatory",
        "--name",
        "Observatory",
        "--home",
        "workshop",
      ]).status,
      0,
    );
    const tooBig = run([
      "project",
      "profile",
      "set",
      "--id",
      "observatory",
      "--purpose",
      "я".repeat(1024),
      "--rules",
      "x",
    ]);
    assert.equal(tooBig.status, 1);
    assert.match(tooBig.stderr, /2048 UTF-8 bytes/);
    const set = run([
      "project",
      "profile",
      "set",
      "--id",
      "observatory",
      "--purpose",
      "Track the fictional observatory dome.",
      "--rules",
      "Keep the shutter closed.",
    ]);
    assert.equal(set.status, 0, set.stderr);
    const shown = JSON.parse(
      run(["project", "profile", "show", "--id", "observatory"]).stdout,
    ) as { profile: { purpose: string; pinned: string[] } };
    assert.equal(
      shown.profile.purpose,
      "Track the fictional observatory dome.",
    );
    assert.deepEqual(shown.profile.pinned, []);
    const cleared = JSON.parse(
      run(["project", "profile", "clear", "--id", "observatory"]).stdout,
    ) as { profile: null };
    assert.equal(cleared.profile, null);
    const missing = JSON.parse(
      run(["project", "profile", "show", "--id", "observatory"]).stdout,
    ) as { profile: null };
    assert.equal(missing.profile, null);
    const unknown = run([
      "project",
      "profile",
      "set",
      "--id",
      "missing",
      "--purpose",
      "Nope.",
      "--rules",
      "Nope.",
    ]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown project/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read returns the profile by id only in the home area", async () => {
  const f = await open("profile-read");
  const sources = f.sources;
  const knowledge = f.knowledge;
  const mcp = createContextMcp(sources, ["personal", scope], false, {
    knowledge,
  });
  const client = new Client({ name: "profile-read", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  try {
    const purpose = "Track the fictional observatory dome.";
    sources.setProfile({
      projectId: "observatory",
      purpose,
      rules: "Keep the shutter closed.",
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["read", "remember", "search", "timeline"]);
    const search = (await client.listTools()).tools.find(
      (tool) => tool.name === "search",
    );
    const fields = search?.inputSchema.properties as Record<string, unknown>;
    assert.equal(fields.purpose, undefined);
    const mode = fields.mode as { description?: string } | undefined;
    assert.match(mode?.description ?? "", /pack/);
    const allowed = await client.callTool({
      name: "read",
      arguments: { scope, id: "profile:observatory" },
    });
    assert.equal(allowed.isError, false);
    const body = allowed.structuredContent as {
      profile?: { purpose: string; homeArea: string };
    };
    assert.equal(body.profile?.purpose, purpose);
    assert.equal(body.profile?.homeArea, scope);
    const denied = await client.callTool({
      name: "read",
      arguments: { scope: "personal", id: "profile:observatory" },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.stringify(denied.structuredContent).includes(purpose),
      false,
    );
    const found = await client.callTool({
      name: "search",
      arguments: { scope, project: "observatory", query: "fictional dome" },
    });
    assert.equal(
      JSON.stringify(found.structuredContent).includes(purpose),
      false,
    );
  } finally {
    await client.close();
    await mcp.close();
    await f.close();
  }
});
