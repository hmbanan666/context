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
import {
  buildTaskPack,
  packProfileShare,
  packRelevance,
  profileSection,
  rankPackItems,
} from "../src/task-pack.js";
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
      before.items.find((item) => item.id === proposed.id)?.status,
      "proposed",
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
      pack.items.find((item) => item.id === proposed.id)?.status,
      "proposed",
    );
    const decisionAt = pack.items.findIndex((item) =>
      item.excerpt.text.includes("spare dome panel"),
    );
    const factAt = pack.items.findIndex((item) => item.id === approvedFact.id);
    const proposedAt = pack.items.findIndex(
      (item) => item.id === newerProposed.id,
    );
    assert.ok(factAt > 0);
    assert.ok(decisionAt > factAt);
    assert.equal(proposedAt, -1);
    assert.equal(pack.items[factAt]?.createdAt, "2026-11-01T00:00:00Z");
    assert.equal(pack.budgetBytes, 8192);
    assert.equal(
      pack.bytesUsed,
      Buffer.byteLength(JSON.stringify(pack), "utf8"),
    );
    assert.ok(pack.bytesUsed <= pack.budgetBytes);
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
      assert.equal(tight.budgetBytes, 512);
      assert.equal(
        tight.bytesUsed,
        Buffer.byteLength(JSON.stringify(tight), "utf8"),
      );
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
      bytesUsed: number;
      budgetBytes: number;
    };
    assert.equal(pack.mode, "pack");
    assert.match(pack.header, /Included:/);
    assert.match(
      pack.items.map((item) => item.excerpt.text).join("\n"),
      /shutter is confirmed closed/,
    );
    assert.equal(typeof pack.bytesUsed, "number");
    assert.equal(pack.budgetBytes, 4096);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rank puts an approved tie ahead of a proposed item and recency breaks the rest", () => {
  const scores = new Map([
    ["old-approved", 1],
    ["new-proposed", 1],
    ["older-proposed", 1],
    ["weak", 0],
    ["strong-proposed", 4],
  ]);
  const ranked = rankPackItems(
    [
      {
        id: "older-proposed",
        status: "proposed",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "new-proposed",
        status: "proposed",
        createdAt: "2026-11-01T00:00:00Z",
      },
      {
        id: "old-approved",
        status: "approved",
        createdAt: "2026-02-01T00:00:00Z",
      },
      { id: "weak", status: "approved", createdAt: "2026-12-01T00:00:00Z" },
      {
        id: "strong-proposed",
        status: "proposed",
        createdAt: "2020-01-01T00:00:00Z",
      },
    ],
    scores,
  );
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["strong-proposed", "old-approved", "new-proposed", "older-proposed"],
  );
  assert.ok(packRelevance(1, "approved") > packRelevance(1, "proposed"));
});

test("an older proposed decision outranks newer unrelated facts and a raw source stays in its share", async () => {
  const mcp = await open("floor");
  try {
    const decisionSource = capture(
      mcp.sources,
      "timeframe",
      "Early note that led to the chart timeframe rule.",
      "2026-01-15T00:00:00Z",
      "observatory",
    );
    const decision = mcp.knowledge.addDistilled({
      scope,
      sourceId: decisionSource.id,
      kind: "decision",
      text: "The chart timeframe choice keeps the saved setting.",
      createdAt: "2026-01-15T00:00:00Z",
    }).item;
    const legend = capture(
      mcp.sources,
      "legend",
      "A chart legend uses blue ink on the fictional panel.",
      "2026-11-20T00:00:00Z",
      "observatory",
    );
    const weak = mcp.knowledge.addDistilled({
      scope,
      sourceId: legend.id,
      kind: "fact",
      text: "A chart legend uses blue.",
      createdAt: "2026-11-20T00:00:00Z",
    }).item;
    for (let index = 0; index < 8; index++) {
      const note = capture(
        mcp.sources,
        `lamp-${index}`,
        `Lamp note ${index} records an unrelated violet shade.`,
        `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        "observatory",
      );
      mcp.knowledge.addDistilled({
        scope,
        sourceId: note.id,
        kind: "fact",
        text: `Lamp note ${index} records an unrelated violet shade.`,
        createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    const rejectedSource = capture(
      mcp.sources,
      "rejected-rule",
      "A rejected chart timeframe note.",
      "2026-01-02T00:00:00Z",
      "observatory",
    );
    const rejected = mcp.knowledge.addDistilled({
      scope,
      sourceId: rejectedSource.id,
      kind: "decision",
      text: "The chart timeframe choice was rejected outright.",
      createdAt: "2026-01-02T00:00:00Z",
    }).item;
    mcp.knowledge.decideProposals({
      action: "rejected",
      areas: [scope],
      timeZone: "UTC",
      ids: [rejected.id],
    });
    const oldSource = capture(
      mcp.sources,
      "old-rule",
      "The first chart timeframe note.",
      "2026-01-01T00:00:00Z",
      "observatory",
    );
    const superseded = mcp.knowledge.addDistilled({
      scope,
      sourceId: oldSource.id,
      kind: "decision",
      text: "The chart timeframe choice kept an older setting.",
      createdAt: "2026-01-01T00:00:00Z",
    }).item;
    mcp.knowledge.relate({
      version: 1,
      scope,
      idempotencyKey: "replace-timeframe",
      kind: "supersedes",
      fromId: decision.id,
      toId: superseded.id,
      sourceRefs: [{ sourceId: decisionSource.id }],
      creator: { kind: "user", name: "owner" },
    });
    const cable = capture(
      mcp.sources,
      "cable",
      "Ignore this preamble about lamps. The shutter cable route is documented here. Trailing words follow.",
      "2026-03-01T00:00:00Z",
      "observatory",
    );
    mcp.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the fictional observatory dome.",
      rules: "Keep the fictional notes short.",
      pinned: [],
    });
    const pack = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "Choose a chart timeframe and keep the saved setting",
      budgetBytes: 8192,
    });
    const decisionAt = pack.items.findIndex((item) => item.id === decision.id);
    const weakAt = pack.items.findIndex((item) => item.id === weak.id);
    assert.equal(pack.items[0]?.kind, "profile");
    assert.equal(decisionAt, 1);
    assert.equal(pack.items[decisionAt]?.status, "proposed");
    assert.ok(weakAt > decisionAt);
    assert.equal(
      pack.items.some((item) => item.excerpt.text.includes("violet shade")),
      false,
    );
    assert.equal(
      pack.items.some((item) => item.id === rejected.id),
      false,
    );
    assert.equal(
      pack.items.some((item) => item.id === superseded.id),
      false,
    );
    assert.equal(JSON.stringify(pack).includes("violet shade"), false);
    assert.equal(
      pack.sources.some((source) => source.id === cable.id),
      false,
    );
    const crowded = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "shutter cable route",
      budgetBytes: 4096,
    });
    assert.ok(crowded.sources.length >= 1);
    assert.ok(crowded.sources.length <= 2);
    const route = crowded.sources.find((source) => source.id === cable.id);
    assert.ok(route);
    assert.match(route.excerpt.text, /^The shutter cable route/);
    assert.equal(route.excerpt.text.includes("preamble"), false);
    assert.equal(crowded.bytesUsed <= crowded.budgetBytes, true);
    assert.equal(
      crowded.bytesUsed,
      Buffer.byteLength(JSON.stringify(crowded), "utf8"),
    );
  } finally {
    await mcp.close();
  }
});

test("a Russian task ranks the inflected decision above a newer partial match", async () => {
  const mcp = await open("ru");
  try {
    const source = capture(
      mcp.sources,
      "ru-decision",
      "Исходная заметка про выбор таймфрейма.",
      "2026-02-01T00:00:00Z",
      "observatory",
    );
    const decision = mcp.knowledge.addDistilled({
      scope,
      sourceId: source.id,
      kind: "decision",
      text: "Выбор таймфрейма сохраняет настройку графика.",
      createdAt: "2026-02-01T00:00:00Z",
    }).item;
    const weakSource = capture(
      mcp.sources,
      "ru-weak",
      "Графика была обновлена в холле.",
      "2026-11-21T00:00:00Z",
      "observatory",
    );
    const weak = mcp.knowledge.addDistilled({
      scope,
      sourceId: weakSource.id,
      kind: "fact",
      text: "Графика была обновлена в холле.",
      createdAt: "2026-11-21T00:00:00Z",
    }).item;
    for (let index = 0; index < 6; index++) {
      const note = capture(
        mcp.sources,
        `ru-lamp-${index}`,
        `Еженедельная заметка ${index} перечисляет цвета ламп.`,
        `2026-11-${String(index + 10).padStart(2, "0")}T00:00:00Z`,
        "observatory",
      );
      mcp.knowledge.addDistilled({
        scope,
        sourceId: note.id,
        kind: "fact",
        text: `Еженедельная заметка ${index} перечисляет цвета ламп.`,
        createdAt: `2026-11-${String(index + 10).padStart(2, "0")}T00:00:00Z`,
      });
    }
    const pack = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "добавить новый таймфрейм на график",
      budgetBytes: 8192,
    });
    const decisionAt = pack.items.findIndex((item) => item.id === decision.id);
    const weakAt = pack.items.findIndex((item) => item.id === weak.id);
    assert.equal(decisionAt, 0);
    assert.equal(pack.items[decisionAt]?.status, "proposed");
    assert.ok(weakAt > decisionAt);
    assert.equal(
      pack.items.some((item) => item.excerpt.text.includes("цвета ламп")),
      false,
    );
    assert.ok(pack.bytesUsed < pack.budgetBytes);
  } finally {
    await mcp.close();
  }
});

test("an approved match outranks a newer proposed match, and two journals fit the small share", async () => {
  const mcp = await open("boost");
  try {
    const older = capture(
      mcp.sources,
      "approved-latch",
      "Notes for the approved violetlatch rule.",
      "2026-01-04T00:00:00Z",
      "observatory",
    );
    const newer = capture(
      mcp.sources,
      "proposed-latch",
      "Notes for the proposed violetlatch rule.",
      "2026-11-04T00:00:00Z",
      "observatory",
    );
    const approved = mcp.knowledge.addDistilled({
      scope,
      sourceId: older.id,
      kind: "decision",
      text: "Keep the violetlatch closed.",
      createdAt: "2026-01-04T00:00:00Z",
    }).item;
    const proposed = mcp.knowledge.addDistilled({
      scope,
      sourceId: newer.id,
      kind: "decision",
      text: "Keep the violetlatch closed today.",
      createdAt: "2026-11-04T00:00:00Z",
    }).item;
    mcp.knowledge.decideProposals({
      action: "approved",
      areas: [scope],
      timeZone: "UTC",
      ids: [approved.id],
    });
    const monday = capture(
      mcp.sources,
      "monday",
      "Monday shutter note.",
      "2026-11-02T00:00:00Z",
      "observatory",
    );
    const friday = capture(
      mcp.sources,
      "friday",
      "Friday shutter note.",
      "2026-11-09T00:00:00Z",
      "observatory",
    );
    const night = capture(
      mcp.sources,
      "night",
      "Night shutter note.",
      "2026-11-16T00:00:00Z",
      "observatory",
    );
    const lamp = capture(
      mcp.sources,
      "lamp-week",
      "Lamp week note.",
      "2026-10-05T00:00:00Z",
      "observatory",
    );
    mcp.knowledge.addDistilled({
      scope,
      sourceId: monday.id,
      kind: "decision",
      text: "The shutter stays closed on Mondays.",
      createdAt: "2026-11-02T00:00:00Z",
    });
    mcp.knowledge.addDistilled({
      scope,
      sourceId: friday.id,
      kind: "decision",
      text: "The shutter stays closed on Fridays.",
      createdAt: "2026-11-09T00:00:00Z",
    });
    mcp.knowledge.addDistilled({
      scope,
      sourceId: night.id,
      kind: "decision",
      text: "The shutter stays closed at night.",
      createdAt: "2026-11-16T00:00:00Z",
    });
    mcp.knowledge.addDistilled({
      scope,
      sourceId: lamp.id,
      kind: "fact",
      text: "Lamp colors were violet that week.",
      createdAt: "2026-10-05T00:00:00Z",
    });
    mcp.knowledge.refreshJournals({
      areas: [scope],
      now: new Date("2026-11-18T00:00:00.000Z"),
      timeZone: "UTC",
      dryRun: false,
      backfillLimit: 8,
    });
    const ranked = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "violetlatch closed",
      budgetBytes: 8192,
    });
    const approvedAt = ranked.items.findIndex(
      (item) => item.id === approved.id,
    );
    const proposedAt = ranked.items.findIndex(
      (item) => item.id === proposed.id,
    );
    assert.ok(approvedAt >= 0);
    assert.ok(proposedAt > approvedAt);
    assert.equal(ranked.items[approvedAt]?.status, "approved");
    assert.equal(ranked.items[proposedAt]?.status, "proposed");
    const journals = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "shutter stays closed",
      budgetBytes: 8192,
    });
    const paragraphs = journals.items.filter((item) => item.kind === "journal");
    assert.ok(paragraphs.length >= 1);
    assert.ok(paragraphs.length <= 2);
    const text = paragraphs.map((item) => item.excerpt.text).join("\n");
    assert.match(text, /at night/);
    assert.match(text, /on Fridays/);
    assert.equal(text.includes("on Mondays"), false);
    assert.equal(text.includes("violet"), false);
    assert.match(journals.header, /journals/);
    assert.equal(
      journals.header.includes("journals (partial)") || paragraphs.length === 2,
      true,
    );
  } finally {
    await mcp.close();
  }
});

test("matching facts do not consume the share reserved for a raw source", async () => {
  const mcp = await open("share");
  try {
    const cable = capture(
      mcp.sources,
      "alignment-cable",
      "Ignore the lamp preamble. The cobalt mirror alignment cable is labeled. Trailing note.",
      "2026-04-01T00:00:00Z",
      "observatory",
    );
    for (let index = 0; index < 12; index++) {
      const note = capture(
        mcp.sources,
        `alignment-${index}`,
        `Reading ${index}.`,
        `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        "observatory",
      );
      mcp.knowledge.addDistilled({
        scope,
        sourceId: note.id,
        kind: "fact",
        text: `The cobalt mirror alignment reading ${index} is stable.`,
        createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    const pack = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "cobalt mirror alignment",
      budgetBytes: 1800,
    });
    const facts = pack.items.filter((item) => item.kind === "fact");
    assert.ok(facts.length > 0);
    assert.ok(facts.length < 12);
    assert.equal(
      pack.sources.some((source) => source.id === cable.id),
      true,
    );
    assert.ok(pack.sources.length <= 2);
    assert.match(
      pack.sources.find((source) => source.id === cable.id)?.excerpt.text ?? "",
      /^The cobalt mirror alignment cable/,
    );
    assert.equal(JSON.stringify(pack).includes("lamp preamble"), false);
    assert.ok(pack.bytesUsed <= 1800);
    assert.equal(pack.budgetBytes, 1800);
  } finally {
    await mcp.close();
  }
});

function fatRules(purpose: string, target = 1700): string {
  const sentence = "Keep the fictional notes in this synthetic profile.";
  let rules = sentence;
  while (Buffer.byteLength(`${purpose}\n${rules} ${sentence}`, "utf8") < target)
    rules = `${rules} ${sentence}`;
  return rules;
}

test("a 4096 pack caps a large profile and drops the backup neighbour", async () => {
  const mcp = await open("prod-context");
  try {
    const purpose = "Hold fictional context notes.";
    const rules = fatRules(purpose);
    mcp.sources.setProfile({
      projectId: "observatory",
      purpose,
      rules,
    });
    mcp.sources.setGlossaryTerm({
      projectId: "observatory",
      term: "дистилляция",
      synonyms: ["distill", "distillation", "tidy"],
    });
    const notes = [
      "ADR-0011 nightly tidy distills each source into a short proposed fact.",
      "Nightly distillation keeps a cursor and resumes the next tidy pass.",
      "The tidy distill pass skips an eighty character prose span.",
      "Distillation stores proposed facts before the nightly journal rewrite.",
      "Nightly off-host backups copy a SQLite snapshot to S3 or SFTP.",
    ];
    notes.forEach((text, index) => {
      const source = capture(
        mcp.sources,
        `prod-context-${index}`,
        text,
        `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        "observatory",
      );
      mcp.knowledge.addDistilled({
        scope,
        sourceId: source.id,
        kind: "decision",
        text,
        createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      });
    });
    const pack = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "улучшить ночную дистилляцию",
      budgetBytes: 4096,
    });
    const profile = pack.items[0];
    assert.equal(profile?.kind, "profile");
    assert.match(profile?.excerpt.text ?? "", /^Hold fictional context notes/);
    assert.ok(
      Buffer.byteLength(profile?.excerpt.text ?? "", "utf8") <=
        Math.floor(4096 * packProfileShare),
    );
    const decisions = pack.items.filter((item) => item.kind === "decision");
    assert.ok(
      decisions.length >= 3 && decisions.length <= 5,
      `decisions ${decisions.length}`,
    );
    assert.equal(JSON.stringify(pack).includes("distills each source"), true);
    assert.equal(JSON.stringify(pack).includes("off-host backups"), false);
    assert.ok(pack.bytesUsed <= 4096);
    const stored = mcp.sources.profile("observatory");
    assert.equal(stored?.rules, rules);
    assert.ok(Buffer.byteLength(profileSection(stored!), "utf8") > 1600);
  } finally {
    await mcp.close();
  }
});

test("a relevant raw source is swapped for its distilled decision", async () => {
  const mcp = await open("prod-expi");
  try {
    const purpose = "Hold fictional expi notes.";
    const rules = fatRules(purpose);
    mcp.sources.setProfile({
      projectId: "observatory",
      purpose,
      rules,
    });
    const pr = capture(
      mcp.sources,
      "matrix-pr",
      "Добавить таймфрейм на график Matrix. matrix-window-pr discusses the control.",
      "2026-04-01T00:00:00Z",
      "observatory",
    );
    mcp.knowledge.addDistilled({
      scope,
      sourceId: pr.id,
      kind: "decision",
      text: "Ship the saved window control on that panel.",
      createdAt: "2026-04-01T00:00:00Z",
    });
    const notes = [
      "Таймфрейм на графике Matrix сохраняет выбранное окно.",
      "График Matrix показывает один таймфрейм.",
      "Новый таймфрейм графика Matrix включается из настроек.",
      "Еженедельная заметка перечисляет цвета ламп.",
    ];
    notes.forEach((text, index) => {
      const source = capture(
        mcp.sources,
        `matrix-${index}`,
        text,
        `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        "observatory",
      );
      mcp.knowledge.addDistilled({
        scope,
        sourceId: source.id,
        kind: "decision",
        text,
        createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      });
    });
    const pack = buildTaskPack(mcp.sources, mcp.knowledge, {
      scope,
      projectId: "observatory",
      question: "добавить таймфрейм на график Matrix",
      budgetBytes: 4096,
    });
    const profile = pack.items[0];
    assert.equal(profile?.kind, "profile");
    assert.ok(
      Buffer.byteLength(profile?.excerpt.text ?? "", "utf8") <=
        Math.floor(4096 * packProfileShare),
    );
    const body = JSON.stringify(pack);
    assert.equal(body.includes("saved window control"), true);
    assert.equal(body.includes("matrix-window-pr"), false);
    assert.equal(body.includes("цвета ламп"), false);
    const decisions = pack.items.filter((item) => item.kind === "decision");
    assert.ok(
      decisions.length >= 3 && decisions.length <= 5,
      `decisions ${decisions.length}: ${decisions.map((item) => item.excerpt.text).join(" | ")}`,
    );
    assert.ok(pack.bytesUsed <= 4096);
    const full = mcp.sources.readProfile("profile:observatory", scope);
    assert.equal(full?.rules, rules);
  } finally {
    await mcp.close();
  }
});
