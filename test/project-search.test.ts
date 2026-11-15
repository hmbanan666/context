import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { buildContextPackage } from "../src/context-package.js";
import { evaluate } from "../src/eval-runner.js";
import { isoWeek } from "../src/journal.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";
import { seedProjectMemoryCorpus } from "./fixtures/project-memory-corpus.js";

const scope = "workshop";
const october = {
  since: "2026-10-01T00:00:00Z",
  until: "2026-11-01T00:00:00Z",
};
const card = z.object({
  items: z.array(
    z.object({
      kind: z.string(),
      status: z.string(),
      createdAt: z.string(),
      excerpt: z.object({ text: z.string() }),
      sourceIds: z.array(z.string()),
      sourceLinks: z
        .array(z.object({ id: z.string(), url: z.string().optional() }))
        .optional(),
    }),
  ),
  sources: z.array(
    z.object({
      excerpt: z.object({ text: z.string() }),
    }),
  ),
  truncated: z.boolean(),
  coverage: z.object({ reasons: z.array(z.string()) }),
});

async function open() {
  const directory = await mkdtemp(join(tmpdir(), "context-project-search-"));
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
  const capture = (
    key: string,
    text: string,
    createdAt: string,
    project: string,
    sourceUri?: string,
  ) =>
    sources.captureMaterial(
      {
        version: 1,
        scope,
        origin: "synthetic:project-search",
        idempotencyKey: key,
        text,
        metadata: {
          createdAt,
          ...(sourceUri ? { sourceUri } : {}),
        },
      },
      undefined,
      [project],
    ).material.source;
  const cited = capture(
    "cited-pr",
    "Pull request archive for the observatory work. diff hunk discussion continues below.",
    "2026-10-12T00:00:00Z",
    "observatory",
    "https://fictional.example/observatory/pr/14",
  );
  capture(
    "logbook",
    "The observatory uncited logbook calibration is separate.",
    "2026-10-20T00:00:00Z",
    "observatory",
  );
  const september = capture(
    "september",
    "September observatory lantern note.",
    "2026-09-15T00:00:00Z",
    "observatory",
  );
  const november = capture(
    "november",
    "November observatory dome note.",
    "2026-11-02T00:00:00Z",
    "observatory",
  );
  const approvedSource = capture(
    "approved-source",
    "Observatory shutter meeting notes.",
    "2026-10-08T00:00:00Z",
    "observatory",
  );
  const rejectedSource = capture(
    "rejected-source",
    "Observatory spare-dome meeting notes.",
    "2026-10-09T00:00:00Z",
    "observatory",
  );
  const notebook = capture(
    "notebook",
    "Notebook archive note for a different undertaking.",
    "2026-10-18T00:00:00Z",
    "notebook",
  );
  knowledge.addDistilled({
    scope,
    sourceId: cited.id,
    kind: "fact",
    text: "In October 2026 the observatory project shipped the cobalt mirror mount.",
    createdAt: "2026-10-12T00:00:00Z",
  });
  knowledge.addDistilled({
    scope,
    sourceId: september.id,
    kind: "fact",
    text: "In September 2026 the observatory project stored a lantern.",
    createdAt: "2026-09-15T00:00:00Z",
  });
  knowledge.addDistilled({
    scope,
    sourceId: november.id,
    kind: "fact",
    text: "In November 2026 the observatory project opened the dome.",
    createdAt: "2026-11-02T00:00:00Z",
  });
  const approved = knowledge.addDistilled({
    scope,
    sourceId: approvedSource.id,
    kind: "decision",
    text: "The observatory project approved the shutter interlock rule.",
    createdAt: "2026-10-08T00:00:00Z",
  }).item;
  const rejected = knowledge.addDistilled({
    scope,
    sourceId: rejectedSource.id,
    kind: "decision",
    text: "The observatory project rejected the spare dome panel.",
    createdAt: "2026-10-09T00:00:00Z",
  }).item;
  knowledge.addDistilled({
    scope,
    sourceId: notebook.id,
    kind: "fact",
    text: "In October 2026 the notebook project renamed its index.",
    createdAt: "2026-10-18T00:00:00Z",
  });
  for (let index = 0; index < 12; index++) {
    const source = capture(
      `budget-${index}`,
      `Budgettoken source ${index} citedbudgetbody.`,
      "2026-10-03T00:00:00Z",
      "observatory",
    );
    knowledge.addDistilled({
      scope,
      sourceId: source.id,
      kind: "fact",
      text: `Budgettoken item ${index} keeps a long fictional sentence ${"m".repeat(280)}.`,
      createdAt: "2026-10-03T00:00:00Z",
    });
  }
  capture(
    "budget-uncited",
    "Budgettoken uncitedbudgetbody sits outside the distilled set.",
    "2026-10-04T00:00:00Z",
    "observatory",
  );
  const reviews = new DatabaseSync(path);
  reviews
    .prepare(
      `INSERT INTO knowledge_reviews
        (id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
       VALUES (?, ?, ?, 'approved', 'Fictional owner approval', 'fixture', '{}', '2026-10-21T00:00:00Z')`,
    )
    .run("approve-shutter", approved.id, scope);
  reviews
    .prepare(
      `INSERT INTO knowledge_reviews
        (id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
       VALUES (?, ?, ?, 'rejected', 'Fictional owner rejection', 'fixture', '{}', '2026-10-21T00:00:00Z')`,
    )
    .run("reject-dome", rejected.id, scope);
  reviews.close();
  const mcp = createContextMcp(sources, [scope], false, { knowledge });
  const client = new Client({ name: "project-search", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  return {
    sources,
    knowledge,
    client,
    async call(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: { scope, ...args } });
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

test("project search ranks distilled items, filters dates, omits cited sources and bounds bytes", async () => {
  const mcp = await open();
  try {
    const listed = (await mcp.client.listTools()).tools.map(
      (tool) => tool.name,
    );
    assert.deepEqual(listed.sort(), ["read", "remember", "search", "timeline"]);
    const narrow = await mcp.call("search", {
      query: "budgettoken",
      project: "observatory",
      budgetBytes: 1024,
    });
    assert.equal(narrow.isError, true);

    const focused = card.parse(
      (
        await mcp.call("search", {
          query: "What happened in October on the observatory project?",
          project: "observatory",
          budgetBytes: 16384,
          ...october,
        })
      ).structuredContent,
    );
    const itemText = focused.items.map((item) => item.excerpt.text).join("\n");
    assert.match(itemText, /shipped the cobalt mirror mount/);
    assert.match(itemText, /approved the shutter interlock rule/);
    assert.equal(itemText.includes("stored a lantern"), false);
    assert.equal(itemText.includes("opened the dome"), false);
    assert.equal(itemText.includes("rejected the spare dome"), false);
    assert.equal(itemText.includes("renamed its index"), false);
    const proposed = focused.items.find((item) =>
      item.excerpt.text.includes("cobalt mirror"),
    );
    const approved = focused.items.find((item) =>
      item.excerpt.text.includes("shutter interlock"),
    );
    assert.equal(proposed?.status, "proposed");
    assert.equal(proposed?.kind, "fact");
    assert.equal(proposed?.createdAt, "2026-10-12T00:00:00Z");
    assert.deepEqual(proposed?.sourceLinks, [
      {
        id: proposed?.sourceIds[0],
        url: "https://fictional.example/observatory/pr/14",
      },
    ]);
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.kind, "decision");
    const packed = JSON.stringify(focused);
    assert.equal(packed.includes("diff hunk discussion"), false);
    assert.match(packed, /uncited logbook/);
    assert.ok(
      packed.indexOf("shipped the cobalt mirror mount") <
        packed.indexOf("uncited logbook"),
    );

    const wide = card.parse(
      (await mcp.call("search", { query: "observatory" })).structuredContent,
    );
    assert.equal(
      wide.items.some(
        (item) => item.kind === "fact" || item.kind === "decision",
      ),
      false,
    );
    assert.match(JSON.stringify(wide), /diff hunk discussion/);

    const tight = card.parse(
      (
        await mcp.call("search", {
          query: "budgettoken",
          project: "observatory",
          ...october,
          budgetBytes: 2048,
          k: 20,
        })
      ).structuredContent,
    );
    assert.equal(tight.truncated, true);
    assert.ok(tight.coverage.reasons.includes("byte_limit"));
    assert.ok(tight.items.length > 0);
    assert.ok(
      tight.items.every(
        (item) => item.kind === "fact" || item.kind === "decision",
      ),
    );
    assert.equal(JSON.stringify(tight).includes("citedbudgetbody"), false);
    assert.equal(JSON.stringify(tight).includes("uncitedbudgetbody"), false);
    const bounded = buildContextPackage(
      mcp.sources,
      mcp.knowledge,
      {
        version: 1,
        scope,
        question: "budgettoken",
        from: october.since,
        until: october.until,
        limit: 20,
        maxBytes: 2048,
      },
      undefined,
      "observatory",
    );
    assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 2048);
  } finally {
    await mcp.close();
  }
});

test("a vague Russian period query recalls in-window items with no lexical hit", async () => {
  const mcp = await open();
  try {
    mcp.knowledge.refreshJournals({
      areas: [scope],
      now: new Date("2026-11-14T00:00:00.000Z"),
      timeZone: "UTC",
      dryRun: false,
      backfillLimit: 8,
    });
    const vague = card.parse(
      (
        await mcp.call("search", {
          query: "что было сделано в октябре",
          project: "observatory",
          budgetBytes: 32768,
          ...october,
        })
      ).structuredContent,
    );
    assert.equal(vague.items[0]?.kind, "journal");
    const kinds = vague.items.map((item) => item.kind);
    const firstFact = kinds.indexOf("fact");
    const lastDecision = kinds.lastIndexOf("decision");
    assert.ok(lastDecision >= 0 && firstFact > lastDecision);
    const text = vague.items.map((item) => item.excerpt.text).join("\n");
    assert.match(text, /cobalt mirror/);
    assert.match(text, /shutter interlock/);
    assert.equal(text.includes("stored a lantern"), false);
    assert.equal(text.includes("opened the dome"), false);
    assert.equal(text.includes("rejected the spare dome"), false);
    assert.equal(text.includes("renamed its index"), false);
    assert.equal(JSON.stringify(vague).includes("diff hunk discussion"), false);
    const undated = card.parse(
      (
        await mcp.call("search", {
          query: "cobalt mirror",
          project: "observatory",
        })
      ).structuredContent,
    );
    assert.equal(
      undated.items.some((item) =>
        item.excerpt.text.includes("shutter interlock"),
      ),
      false,
    );
  } finally {
    await mcp.close();
  }
});

test("project search starts a decision excerpt on a sentence boundary after journals", async () => {
  const mcp = await open();
  try {
    const source = mcp.sources.captureMaterial(
      {
        version: 1,
        scope,
        origin: "synthetic:project-search",
        idempotencyKey: "violetlatch",
        text: "Observatory notes for the violetlatch decision.",
        metadata: { createdAt: "2026-10-15T00:00:00.000Z" },
      },
      undefined,
      ["observatory"],
    ).material.source;
    const text =
      "The observatory project noted the weekly staffing rota. The observatory project kept the cobalt mirror and closed the violetlatch after the storm.";
    mcp.knowledge.addDistilled({
      scope,
      sourceId: source.id,
      kind: "decision",
      text,
      createdAt: "2026-10-15T00:00:00.000Z",
    });
    mcp.knowledge.refreshJournals({
      areas: [scope],
      now: new Date("2026-10-15T12:00:00.000Z"),
      timeZone: "UTC",
      dryRun: false,
    });
    const result = card.parse(
      (
        await mcp.call("search", {
          query: "violetlatch",
          project: "observatory",
          budgetBytes: 16384,
          ...october,
        })
      ).structuredContent,
    );
    const decisionIndex = result.items.findIndex(
      (item) =>
        item.kind === "decision" && item.excerpt.text.includes("violetlatch"),
    );
    const journalIndex = result.items.findIndex(
      (item) => item.kind === "journal",
    );
    assert.ok(journalIndex >= 0);
    assert.ok(decisionIndex > journalIndex);
    const decision = result.items[decisionIndex];
    assert.equal(
      decision?.excerpt.text.startsWith(
        "The observatory project kept the cobalt mirror",
      ),
      true,
    );
    assert.equal(decision?.excerpt.text.includes("staffing rota"), false);
    assert.equal(decision?.excerpt.text.endsWith("."), true);
  } finally {
    await mcp.close();
  }
});

test("the public October project question and pack cases pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-project-eval-"));
  const path = join(directory, "context.db");
  try {
    seedProjectMemoryCorpus(path);
    const run = await evaluate({
      databasePath: path,
      questionsPath: join("fixtures", "evals", "project-memory.yaml"),
      directory: join(directory, "evals"),
      areas: ["workshop"],
      k: 10,
    });
    const question = (id: string) =>
      run.questions.find((item) => item.id === id);
    assert.equal(
      run.outcome,
      "completed",
      JSON.stringify(question("october_on_project")),
    );
    assert.equal(run.metrics.isolation_violations, 0);
    assert.equal(question("october_on_project")?.pass, true);
    assert.equal(question("october_on_project")?.hit_at_k, 1);
    assert.equal(question("pack_for_task")?.status, "completed");
    assert.equal(question("pack_for_task")?.pass, true);
    assert.equal(question("pack_budget")?.status, "completed");
    assert.equal(question("pack_budget")?.pass, true);
    assert.equal(question("pack_proposed_decision")?.pass, true);
    assert.equal(question("pack_proposed_decision")?.outranks_pass, true);
    assert.equal(question("pack_russian_task")?.pass, true);
    assert.equal(question("pack_russian_task")?.outranks_pass, true);
    assert.equal(run.metrics.hit_at_k, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("undated search keeps a full-query fact in the top 3 and period recall stays in kind order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-merged-rank-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const area = "lab";
  try {
    sources.createProject({
      id: "observatory",
      name: "Observatory",
      homeArea: area,
    });
    const repeated = Array.from({ length: 20 }, () => "cobalt lantern").join(
      " ",
    );
    const long = `The ${repeated} stays packed in the fictional hall.`;
    const capture = (
      key: string,
      text: string,
      createdAt: string,
      kind: "decision" | "fact",
    ) => {
      const source = sources.captureMaterial(
        {
          version: 1,
          scope: area,
          origin: "synthetic:merged-rank",
          idempotencyKey: key,
          text,
          metadata: { createdAt },
        },
        undefined,
        ["observatory"],
      ).material.source;
      return knowledge.addDistilled({
        scope: area,
        sourceId: source.id,
        kind,
        text,
        createdAt,
      }).item;
    };
    for (const [index, createdAt] of [
      "2026-01-05T00:00:00.000Z",
      "2026-01-19T00:00:00.000Z",
      "2026-02-02T00:00:00.000Z",
      "2026-02-16T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-16T00:00:00.000Z",
    ].entries())
      capture(`week-${index}`, long, createdAt, "decision");
    knowledge.refreshJournals({
      areas: [area],
      now: new Date("2026-11-14T00:00:00.000Z"),
      timeZone: "UTC",
      dryRun: false,
      backfillLimit: 24,
    });
    for (let index = 0; index < 15; index++) {
      const day = String(index + 1).padStart(2, "0");
      capture(
        `common-${index}`,
        "The cobalt lantern stays in the fictional hall.",
        `2026-04-${day}T00:00:00.000Z`,
        "decision",
      );
    }
    const fact = capture(
      "whole",
      "The cobalt mirror shipment is logged for the dock.",
      "2026-03-20T00:00:00.000Z",
      "fact",
    );
    const undated = buildContextPackage(
      sources,
      knowledge,
      {
        version: 1,
        scope: area,
        question: "cobalt mirror shipment",
        limit: 10,
        maxBytes: 8192,
      },
      undefined,
      "observatory",
    );
    assert.ok(Buffer.byteLength(JSON.stringify(undated), "utf8") <= 8192);
    const factAt = undated.items.findIndex((item) => item.id === fact.id);
    assert.ok(
      factAt >= 0 && factAt < 3,
      undated.items
        .map((item) => `${item.kind}:${item.excerpt.text}`)
        .join("\n"),
    );
    const journals = undated.items.filter((item) => item.kind === "journal");
    assert.equal(journals.length, 2);
    assert.ok(journals.every((item) => item.excerpt.text.length <= 240));
    const period = buildContextPackage(
      sources,
      knowledge,
      {
        version: 1,
        scope: area,
        question: "violetmarker",
        from: "2026-01-01T00:00:00.000Z",
        until: "2026-04-01T00:00:00.000Z",
        limit: 20,
        maxBytes: 65536,
      },
      undefined,
      "observatory",
    );
    const kinds = period.items.map((item) => item.kind);
    assert.ok(
      kinds.filter((kind) => kind === "journal").length > 2,
      kinds.join(","),
    );
    const lastJournal = kinds.lastIndexOf("journal");
    const firstDecision = kinds.indexOf("decision");
    const factIndex = period.items.findIndex((item) => item.id === fact.id);
    assert.ok(firstDecision > lastJournal);
    assert.ok(factIndex > firstDecision);
    const periodJournal = period.items.find((item) => item.kind === "journal");
    assert.ok((periodJournal?.excerpt.text.length ?? 0) > 240);
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dated search keeps every week that overlaps the month, oldest first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-period-overlap-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const area = "lab";
  const zone = "Europe/Berlin";
  const since = "2026-10-01T00:00:00.000Z";
  const until = "2026-11-01T00:00:00.000Z";
  try {
    sources.createProject({
      id: "expi",
      name: "Expi",
      homeArea: area,
    });
    const sentence = (token: string, lantern: boolean) => {
      const lead = lantern
        ? `The fictional lantern ${token} note records one synthetic hall check.`
        : `The fictional ${token} note records one synthetic hall check.`;
      return `${lead} ${"Keep the cobalt lamp steady. ".repeat(8)}`.trim();
    };
    const stamps = [
      {
        at: "2026-09-20T10:00:00.000Z",
        token: "septemberonly",
        inRange: false,
      },
      {
        at: "2026-09-30T10:00:00.000Z",
        token: "boundaryshutter",
        inRange: true,
      },
      { at: "2026-10-07T10:00:00.000Z", token: "weekfortyone", inRange: true },
      { at: "2026-10-14T10:00:00.000Z", token: "weekfortytwo", inRange: true },
      {
        at: "2026-10-21T10:00:00.000Z",
        token: "weekfortythree",
        inRange: true,
      },
      { at: "2026-10-28T11:00:00.000Z", token: "weekfortyfour", inRange: true },
      { at: "2026-11-04T11:00:00.000Z", token: "novemberonly", inRange: false },
    ];
    stamps.forEach((stamp, index) => {
      const text = sentence(stamp.token, stamp.inRange && index !== 1);
      const source = sources.captureMaterial(
        {
          version: 1,
          scope: area,
          origin: "synthetic:period-overlap",
          idempotencyKey: `overlap-${index}`,
          text,
          metadata: { createdAt: stamp.at },
        },
        undefined,
        ["expi"],
      ).material.source;
      knowledge.addDistilled({
        scope: area,
        sourceId: source.id,
        kind: "decision",
        text,
        createdAt: stamp.at,
      });
    });
    knowledge.refreshJournals({
      areas: [area],
      now: new Date("2026-11-15T12:00:00.000Z"),
      timeZone: zone,
      dryRun: false,
      backfillLimit: 24,
    });
    const expectedWeeks = stamps
      .filter((stamp) => stamp.inRange)
      .map((stamp) => isoWeek(new Date(stamp.at), zone).id);
    assert.deepEqual(
      expectedWeeks[0],
      isoWeek(new Date("2026-09-28T12:00:00+02:00"), zone).id,
    );
    const search = (question: string, maxBytes = 8192) =>
      buildContextPackage(
        sources,
        knowledge,
        {
          version: 1,
          scope: area,
          question,
          from: since,
          until,
          limit: 20,
          maxBytes,
        },
        undefined,
        "expi",
      );
    const period = search("что делали в октябре");
    const weeks = period.items
      .filter((item) => item.kind === "journal")
      .map((item) => item.excerpt.text.match(/2026-W\d{2}/u)?.[0]);
    assert.deepEqual(
      weeks,
      expectedWeeks,
      period.items.map((item) => item.excerpt.text.slice(0, 80)).join("\n"),
    );
    assert.ok(weeks.length > 2);
    const kinds = period.items.map((item) => item.kind);
    const lastJournal = kinds.lastIndexOf("journal");
    const firstDecision = kinds.indexOf("decision");
    assert.ok(firstDecision > lastJournal);
    assert.equal(
      period.items.some(
        (item) =>
          item.kind === "decision" &&
          item.excerpt.text.includes("boundaryshutter"),
      ),
      false,
    );
    const boundary = period.items.find(
      (item) =>
        item.kind === "journal" &&
        item.excerpt.text.includes("boundaryshutter"),
    );
    assert.ok((boundary?.excerpt.text.length ?? 0) > 240);
    assert.ok((boundary?.excerpt.text.length ?? 0) <= 480);
    assert.equal(
      period.items.some((item) => item.excerpt.text.includes("septemberonly")),
      false,
    );
    assert.equal(
      period.items.some((item) => item.excerpt.text.includes("novemberonly")),
      false,
    );
    const matched = search("lantern", 65536);
    const matchedWeeks = matched.items
      .filter((item) => item.kind === "journal")
      .map((item) => item.excerpt.text.match(/2026-W\d{2}/u)?.[0]);
    assert.deepEqual(matchedWeeks, expectedWeeks);
    const undated = buildContextPackage(
      sources,
      knowledge,
      {
        version: 1,
        scope: area,
        question: "lantern",
        limit: 10,
        maxBytes: 8192,
      },
      undefined,
      "expi",
    );
    const undatedJournals = undated.items.filter(
      (item) => item.kind === "journal",
    );
    assert.equal(undatedJournals.length, 2);
    assert.ok(undatedJournals.every((item) => item.excerpt.text.length <= 240));
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Five and six full journal cards do not fit in the default 8192 bytes.
// Shortening every card on the same sentence boundary keeps each week and
// still leaves room for a later decision. A 2048-byte package that cannot
// hold every week must not fill that hole with a decision.
test("dated search keeps five and six long journals in a month at the default budget", async () => {
  const zone = "UTC";
  const cases = [
    {
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-11-01T00:00:00.000Z",
      weeks: 5,
      sentences: 6,
      sentenceSize: 110,
      url: true,
      question: "что делали в октябре",
    },
    {
      since: "2026-03-01T00:00:00.000Z",
      until: "2026-04-01T00:00:00.000Z",
      weeks: 6,
      sentences: 5,
      sentenceSize: 110,
      url: false,
      question: "что делали в марте",
    },
  ];
  for (const [caseIndex, sample] of cases.entries()) {
    const directory = await mkdtemp(join(tmpdir(), "context-month-journals-"));
    const path = join(directory, "context.db");
    const sources = new SourceStore(path);
    const knowledge = new KnowledgeStore(path);
    const area = "lab";
    try {
      sources.createProject({ id: "expi", name: "Expi", homeArea: area });
      const anchors: string[] = [];
      const seen = new Set<string>();
      for (
        let cursor = Date.parse(sample.since);
        cursor < Date.parse(sample.until);
        cursor += 86_400_000
      ) {
        const week = isoWeek(new Date(cursor), zone);
        if (seen.has(week.id)) continue;
        seen.add(week.id);
        anchors.push(new Date(cursor).toISOString());
      }
      assert.equal(anchors.length, sample.weeks, anchors.join(","));
      const sentence = (token: string, index: number) => {
        const stem = `The fictional ${token} mark ${index} stayed steady`;
        return `${`${stem}${" tonight".repeat(20)}`.slice(0, sample.sentenceSize - 1)}.`;
      };
      anchors.forEach((at, weekIndex) => {
        const token = `week${String(weekIndex).padStart(2, "0")}`;
        for (let index = 0; index < sample.sentences; index++) {
          const text = sentence(token, index);
          const source = sources.captureMaterial(
            {
              version: 1,
              scope: area,
              origin: "synthetic:month-journals",
              idempotencyKey: `month-${caseIndex}-${weekIndex}-${index}`,
              text,
              metadata: {
                createdAt: at,
                ...(sample.url && index === 0
                  ? { sourceUri: "https://e.test/a" }
                  : {}),
              },
            },
            undefined,
            ["expi"],
          ).material.source;
          knowledge.addDistilled({
            scope: area,
            sourceId: source.id,
            kind: "decision",
            text,
            createdAt: at,
          });
        }
      });
      const latest = new Date(Date.parse(sample.until) - 60_000).toISOString();
      const short = "The expi project kept the smalllatch note.";
      const shortSource = sources.captureMaterial(
        {
          version: 1,
          scope: area,
          origin: "synthetic:month-journals",
          idempotencyKey: `month-${caseIndex}-smalllatch`,
          text: short,
          metadata: { createdAt: latest },
        },
        undefined,
        ["expi"],
      ).material.source;
      knowledge.addDistilled({
        scope: area,
        sourceId: shortSource.id,
        kind: "decision",
        text: short,
        createdAt: latest,
      });
      knowledge.refreshJournals({
        areas: [area],
        now: new Date("2026-11-15T12:00:00.000Z"),
        timeZone: zone,
        dryRun: false,
        backfillLimit: 24,
      });
      const search = (maxBytes?: number) =>
        buildContextPackage(
          sources,
          knowledge,
          {
            version: 1,
            scope: area,
            question: sample.question,
            from: sample.since,
            until: sample.until,
            ...(maxBytes === undefined ? {} : { maxBytes }),
          },
          undefined,
          "expi",
        );
      const period = search();
      const journals = period.items.filter((item) => item.kind === "journal");
      const weeks = journals.map(
        (item) => item.excerpt.text.match(/2026-W\d{2}/u)?.[0],
      );
      const expectedWeeks = anchors.map((at) => isoWeek(new Date(at), zone).id);
      assert.deepEqual(
        weeks,
        expectedWeeks,
        JSON.stringify({
          bytes: Buffer.byteLength(JSON.stringify(period), "utf8"),
          reasons: period.coverage.reasons,
          lengths: journals.map((item) => item.excerpt.text.length),
          kinds: period.items.map((item) => item.kind),
          heads: period.items.map((item) => item.excerpt.text.slice(0, 48)),
        }),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(period), "utf8") <= 8192);
      assert.ok(
        period.coverage.reasons.includes("journals_truncated"),
        JSON.stringify({
          bytes: Buffer.byteLength(JSON.stringify(period), "utf8"),
          lengths: journals.map((item) => item.excerpt.text.length),
          card: journals[0]
            ? Buffer.byteLength(JSON.stringify(journals[0]), "utf8")
            : 0,
          reasons: period.coverage.reasons,
          kinds: period.items.map((item) => item.kind),
          decision: period.items
            .filter((item) => item.kind === "decision")
            .map((item) => Buffer.byteLength(JSON.stringify(item), "utf8")),
        }),
      );
      assert.ok(
        journals.every(
          (item) =>
            item.excerpt.text.length >= 200 &&
            item.excerpt.text.length < 480 &&
            /[.!?…。！？]$/u.test(item.excerpt.text),
        ),
        journals.map((item) => item.excerpt.text.length).join(","),
      );
      const kinds = period.items.map((item) => item.kind);
      const lastJournal = kinds.lastIndexOf("journal");
      const decisionAt = period.items.findIndex(
        (item) =>
          item.kind === "decision" && item.excerpt.text.includes("smalllatch"),
      );
      assert.ok(decisionAt > lastJournal, kinds.join(","));
      assert.ok(
        kinds.slice(0, journals.length).every((kind) => kind === "journal"),
      );
      const wide = search(65536);
      assert.equal(wide.coverage.reasons.includes("journals_truncated"), false);
      const wideJournals = wide.items.filter((item) => item.kind === "journal");
      assert.deepEqual(
        wideJournals.map(
          (item) => item.excerpt.text.match(/2026-W\d{2}/u)?.[0],
        ),
        expectedWeeks,
      );
      assert.ok(
        wideJournals.every(
          (item) => item.excerpt.truncated && item.excerpt.text.length <= 480,
        ),
      );
      assert.ok(
        journals.every(
          (item, index) =>
            item.excerpt.text.length <
            (wideJournals[index]?.excerpt.text.length ?? 0),
        ),
        journals.map((item) => item.excerpt.text.length).join(","),
      );
      const cramped = search(2048);
      const crampedWeeks = cramped.items
        .filter((item) => item.kind === "journal")
        .map((item) => item.excerpt.text.match(/2026-W\d{2}/u)?.[0]);
      assert.ok(crampedWeeks.length < expectedWeeks.length);
      assert.deepEqual(
        crampedWeeks,
        expectedWeeks.slice(0, crampedWeeks.length),
      );
      assert.equal(
        cramped.items.some((item) => item.kind !== "journal"),
        false,
      );
      if (sample.weeks === 6) {
        const undated = buildContextPackage(
          sources,
          knowledge,
          {
            version: 1,
            scope: area,
            question: "steady",
            limit: 10,
          },
          undefined,
          "expi",
        );
        const undatedJournals = undated.items.filter(
          (item) => item.kind === "journal",
        );
        assert.equal(undatedJournals.length, 2);
        assert.ok(
          undatedJournals.every((item) => item.excerpt.text.length <= 240),
        );
        assert.equal(
          undated.coverage.reasons.includes("journals_truncated"),
          false,
        );
      }
    } finally {
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
