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
import { buildTaskPack, profileSection } from "../src/task-pack.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";
import { seedProjectMemoryCorpus } from "./fixtures/project-memory-corpus.js";

const scope = "workshop";

async function open(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `context-pack-${name}-`));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  sources.createProject({
    id: "observatory",
    name: "Observatory",
    homeArea: scope,
  });
  sources.createProject({
    id: "notebook",
    name: "Notebook",
    homeArea: scope,
  });
  const mcp = createContextMcp(sources, [scope], false, { knowledge });
  const client = new Client({ name: "task-pack", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  return {
    path,
    sources,
    knowledge,
    async call(args: Record<string, unknown>) {
      return client.callTool({
        name: "search",
        arguments: { scope, ...args },
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

function capture(
  sources: SourceStore,
  key: string,
  text: string,
  createdAt: string,
  project: string,
) {
  return sources.captureMaterial(
    {
      version: 1,
      scope,
      origin: "synthetic:task-pack",
      idempotencyKey: key,
      text,
      metadata: { createdAt },
    },
    undefined,
    [project],
  ).material.source;
}

test("pack keeps the profile, a known decision and the newest facts inside the budget", async () => {
  const mcp = await open("rank");
  try {
    const motor = capture(
      mcp.sources,
      "motor",
      "Notes for the dome motor rule.",
      "2026-09-01T00:00:00Z",
      "observatory",
    );
    const spare = capture(
      mcp.sources,
      "spare",
      "Notes for a spare panel.",
      "2026-11-02T00:00:00Z",
      "observatory",
    );
    const sensor = capture(
      mcp.sources,
      "sensor",
      "raw shutter wiring dump of the fictional sensor.",
      "2026-11-18T00:00:00Z",
      "observatory",
    );
    const other = capture(
      mcp.sources,
      "other",
      "Notebook index note.",
      "2026-11-18T00:00:00Z",
      "notebook",
    );
    const pinned = mcp.knowledge.addDistilled({
      scope,
      sourceId: motor.id,
      kind: "decision",
      text: "Dome motors stay disabled until the shutter is confirmed closed.",
      createdAt: "2026-09-01T00:00:00Z",
    }).item;
    const proposed = mcp.knowledge.addDistilled({
      scope,
      sourceId: spare.id,
      kind: "decision",
      text: "The observatory project may store a spare dome panel.",
      createdAt: "2026-11-02T00:00:00Z",
    }).item;
    const approvedFact = mcp.knowledge.addDistilled({
      scope,
      sourceId: sensor.id,
      kind: "fact",
      text: "The shutter sensor reports open or closed.",
      createdAt: "2026-11-01T00:00:00Z",
    }).item;
    const later = capture(
      mcp.sources,
      "later",
      "A later fictional sensor note.",
      "2026-11-19T00:00:00Z",
      "observatory",
    );
    const newerProposed = mcp.knowledge.addDistilled({
      scope,
      sourceId: later.id,
      kind: "fact",
      text: "A later proposed sensor note stays behind approved facts.",
      createdAt: "2026-11-19T00:00:00Z",
    }).item;
    mcp.knowledge.addDistilled({
      scope,
      sourceId: other.id,
      kind: "decision",
      text: "The notebook project pins its index.",
      createdAt: "2026-11-03T00:00:00Z",
    });
    const before = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "Add a shutter interlock to the dome",
      budgetBytes: 8192,
    });
    assert.equal(
      before.items.some((item) => item.id === proposed.id),
      false,
    );
    mcp.knowledge.decideProposals({
      action: "approved",
      areas: [scope],
      timeZone: "UTC",
      ids: [pinned.id, approvedFact.id],
    });
    mcp.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the fictional observatory dome.",
      rules: "Do not move the dome while the shutter is open.",
      pinned: [pinned.id],
    });
    mcp.knowledge.refreshJournals({
      areas: [scope],
      now: new Date("2026-11-20T00:00:00.000Z"),
      timeZone: "UTC",
      dryRun: false,
    });
    const pack = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "Add a shutter interlock to the dome",
      budgetBytes: 8192,
    });
    const again = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "Add a shutter interlock to the dome",
      budgetBytes: 8192,
    });
    assert.equal(JSON.stringify(pack), JSON.stringify(again));
    assert.match(pack.header, /Included: profile/);
    assert.match(pack.header, /Omitted: .*journals/);
    assert.equal(pack.items[0]?.kind, "profile");
    assert.match(
      pack.items[0]?.excerpt.text ?? "",
      /Track the fictional observatory dome/,
    );
    assert.match(
      pack.items[0]?.excerpt.text ?? "",
      /shutter is confirmed closed/,
    );
    assert.equal(pack.items.filter((item) => item.id === pinned.id).length, 0);
    assert.equal(
      pack.items.some((item) => item.kind === "journal"),
      false,
    );
    assert.equal(
      pack.items.some((item) => item.id === proposed.id),
      false,
    );
    const decisionAt = pack.items.findIndex((item) =>
      item.excerpt.text.includes("spare dome panel"),
    );
    assert.equal(decisionAt, -1);
    const factAt = pack.items.findIndex((item) => item.id === approvedFact.id);
    const proposedAt = pack.items.findIndex(
      (item) => item.id === newerProposed.id,
    );
    assert.ok(factAt > 0);
    assert.ok(proposedAt > factAt);
    assert.equal(pack.items[factAt]?.createdAt, "2026-11-01T00:00:00Z");
    assert.equal(
      JSON.stringify(pack).includes("raw shutter wiring dump"),
      false,
    );
    assert.equal(
      JSON.stringify(pack).includes("notebook project pins its index"),
      false,
    );
    const plain = await mcp.call({
      query: "Add a shutter interlock to the dome",
      project: "observatory",
    });
    assert.equal(
      JSON.stringify(plain.structuredContent).includes(
        "Track the fictional observatory dome",
      ),
      false,
    );
    const names = (await mcp.call({ listProjects: true })).structuredContent;
    assert.equal(JSON.stringify(names).includes("profile"), false);
  } finally {
    await mcp.close();
  }
});

test("a 512-byte pack is a profile prefix and the public fixture stays inside budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-pack-fixture-"));
  const path = join(directory, "context.db");
  try {
    seedProjectMemoryCorpus(path);
    const sources = new SourceStore(path);
    const knowledge = new KnowledgeStore(path);
    try {
      const profile = sources.profile("observatory");
      assert.ok(profile);
      const section = profileSection(profile);
      assert.equal(Buffer.byteLength(section, "utf8"), 1400);
      assert.ok(section.indexOf("Track the fictional observatory dome") < 200);
      assert.ok(section.indexOf("shutter is confirmed closed") > 512);
      const tight = buildTaskPack(sources, knowledge, {
        scope,
        projectId: "observatory",
        question: "Add a shutter interlock to the dome",
        budgetBytes: 512,
      });
      const encoded = JSON.stringify(tight);
      assert.ok(Buffer.byteLength(encoded, "utf8") <= 512);
      assert.equal(tight.truncated, true);
      assert.match(encoded, /Track the fictional observatory dome/);
      assert.equal(encoded.includes("shutter is confirmed closed"), false);
      assert.equal(encoded.includes("raw shutter wiring dump"), false);
      assert.match(tight.header, /profile \(partial\)/);
      const wide = buildTaskPack(sources, knowledge, {
        scope,
        projectId: "observatory",
        question: "Add a shutter interlock to the dome",
        budgetBytes: 4096,
      });
      const wideText = JSON.stringify(wide);
      assert.ok(Buffer.byteLength(wideText, "utf8") <= 4096);
      assert.match(wideText, /shutter is confirmed closed/);
      assert.match(wideText, /reports open or closed/);
      assert.equal(wideText.includes("raw shutter wiring dump"), false);
    } finally {
      knowledge.close();
      sources.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the owner CLI returns the same pack", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-pack-cli-"));
  const path = join(directory, "context.db");
  try {
    seedProjectMemoryCorpus(path);
    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/context.js",
        "search",
        "--mode",
        "pack",
        "--project",
        "observatory",
        "--scope",
        scope,
        "--query",
        "Add a shutter interlock to the dome",
        "--budget-bytes",
        "4096",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CONTEXT_DB_PATH: path,
          CONTEXT_AREAS: scope,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const pack = JSON.parse(result.stdout) as {
      mode: string;
      header: string;
      items: { excerpt: { text: string } }[];
    };
    assert.equal(pack.mode, "pack");
    assert.match(pack.header, /Included:/);
    assert.match(
      pack.items.map((item) => item.excerpt.text).join("\n"),
      /shutter is confirmed closed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
