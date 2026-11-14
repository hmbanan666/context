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
