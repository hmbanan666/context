import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  isoWeek,
  journalCharacterLimit,
  journalExcerpt,
  journalId,
  journalParagraph,
} from "../src/journal.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";
import { runTidy } from "../src/tidy.js";

const scope = "workshop";
const now = new Date("2026-11-11T12:00:00.000Z");

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
  sources.createProject({
    id: "notebook",
    name: "Notebook",
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

function capture(
  sources: SourceStore,
  key: string,
  text: string,
  createdAt: string,
  project = "observatory",
) {
  return sources.captureMaterial(
    {
      version: 1,
      scope,
      origin: "synthetic:journal",
      idempotencyKey: key,
      text,
      metadata: { createdAt },
    },
    undefined,
    [project],
  ).material.source;
}

test("a journal paragraph summarizes decisions before facts in the source language", () => {
  const paragraph = journalParagraph("expi", "2026-W42", [
    {
      id: "fact-late",
      kind: "fact",
      text: "Факт: починили вход в Matrix и оставили название как в источнике.",
      createdAt: "2026-10-18T00:00:00.000Z",
    },
    {
      id: "decision-early",
      kind: "decision",
      text: "Решение: оставить журнал коротким и на языке источника.",
      createdAt: "2026-10-14T00:00:00.000Z",
    },
    {
      id: "fact-early",
      kind: "fact",
      text: "Факт: записали зеркало до решения о входе.",
      createdAt: "2026-10-12T00:00:00.000Z",
    },
  ]);
  assert.equal(paragraph.text.startsWith("expi 2026-W42: "), true);
  assert.equal([...paragraph.text].length <= journalCharacterLimit, true);
  assert.equal(paragraph.text.includes("…"), false);
  assert.equal(paragraph.text.includes("decision-early"), false);
  assert.equal(paragraph.text.includes("fact-early"), false);
  assert.equal(paragraph.text.includes("fact-late"), false);
  assert.deepEqual(paragraph.citedIds, [
    "decision-early",
    "fact-early",
    "fact-late",
  ]);
  const decisionAt = paragraph.text.indexOf("Решение: оставить журнал");
  const factAt = paragraph.text.indexOf("Факт: записали зеркало");
  assert.ok(decisionAt > 0 && decisionAt < factAt);
  assert.equal(paragraph.text.includes("починили вход в Matrix"), true);
  assert.equal(paragraph.text.endsWith("."), true);
  assert.equal(/\bcomplete\b/i.test(paragraph.text), false);
});

test("a journal omits a sentence that does not fit and does not cut it", () => {
  const fitted = `D ${"d".repeat(390)}`;
  const overflow = "n".repeat(400);
  const later = "A later short fact.";
  const paragraph = journalParagraph("observatory", "2026-W46", [
    {
      id: "long-decision",
      kind: "decision",
      text: fitted,
      createdAt: "2026-11-10T00:00:00.000Z",
    },
    {
      id: "overflow-decision",
      kind: "decision",
      text: overflow,
      createdAt: "2026-11-11T00:00:00.000Z",
    },
    {
      id: "short-fact",
      kind: "fact",
      text: later,
      createdAt: "2026-11-12T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(paragraph.citedIds, ["long-decision", "short-fact"]);
  assert.equal(paragraph.text.includes(later), true);
  assert.equal(paragraph.text.includes(overflow), false);
  assert.equal(paragraph.text.includes("…"), false);
  assert.equal(paragraph.text.includes("long-decision"), false);
  assert.equal(paragraph.text.endsWith("."), true);
  assert.equal([...paragraph.text].length <= journalCharacterLimit, true);
  const clipped = journalExcerpt(`${paragraph.text} ${"Z".repeat(400)}`);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text.endsWith("."), true);
  assert.equal(clipped.text.includes("…"), false);
  assert.equal(clipped.text.length <= 480, true);
  const boundary = `${"A".repeat(479)}.${"B".repeat(40)}`;
  const exact = journalExcerpt(boundary, 480);
  assert.equal(exact.text, `${"A".repeat(479)}.`);
  assert.equal(exact.truncated, true);
  assert.equal(exact.text.includes("B"), false);
});

test("ISO weeks follow the instance timezone, including a DST boundary", () => {
  assert.equal(isoWeek(now, "UTC").id, "2026-W46");
  assert.equal(isoWeek(now, "UTC").start, "2026-11-09T00:00:00.000Z");
  assert.equal(isoWeek(now, "UTC").end, "2026-11-16T00:00:00.000Z");
  assert.equal(
    isoWeek(new Date("2026-11-08T21:30:00.000Z"), "Europe/Moscow").id,
    "2026-W46",
  );
  assert.equal(
    isoWeek(new Date("2026-11-08T20:30:00.000Z"), "Europe/Moscow").id,
    "2026-W45",
  );
  const during = new Date("2026-03-04T17:00:00.000Z");
  assert.equal(isoWeek(during, "America/New_York").id, "2026-W10");
  assert.equal(
    isoWeek(new Date("2026-03-09T03:30:00.000Z"), "America/New_York").id,
    "2026-W10",
  );
  assert.equal(
    isoWeek(new Date("2026-03-09T04:30:00.000Z"), "America/New_York").id,
    "2026-W11",
  );
  assert.equal(
    isoWeek(new Date("2026-03-02T04:30:00.000Z"), "America/New_York").id,
    "2026-W09",
  );
});

test("tidy writes one journal for the current and previous weeks and skips an empty week", async () => {
  const f = await open("journal-weeks");
  try {
    const current = capture(
      f.sources,
      "current",
      "Observatory archive. diff hunk discussion stays in the body.",
      "2026-11-11T00:00:00.000Z",
    );
    const previous = capture(
      f.sources,
      "previous",
      "Observatory archive from the previous week.",
      "2026-11-04T00:00:00.000Z",
    );
    const older = capture(
      f.sources,
      "older",
      "Observatory archive from two weeks ago.",
      "2026-10-28T00:00:00.000Z",
    );
    const other = capture(
      f.sources,
      "notebook",
      "Notebook archive.",
      "2026-11-11T00:00:00.000Z",
      "notebook",
    );
    const foreign = f.sources.captureMaterial(
      {
        version: 1,
        scope: "personal",
        origin: "synthetic:journal",
        idempotencyKey: "foreign",
        text: "Personal area note that must stay out of the workshop journal.",
        metadata: { createdAt: "2026-11-11T00:00:00.000Z" },
      },
      undefined,
      ["observatory"],
    ).material.source;
    const currentItem = f.knowledge.addDistilled({
      scope,
      sourceId: current.id,
      kind: "fact",
      text: "In November 2026 the observatory project shipped the cobalt mirror mount.",
      createdAt: "2026-11-11T00:00:00.000Z",
    }).item;
    const previousItem = f.knowledge.addDistilled({
      scope,
      sourceId: previous.id,
      kind: "decision",
      text: "The observatory project kept the lantern rule.",
      createdAt: "2026-11-04T00:00:00.000Z",
    }).item;
    f.knowledge.addDistilled({
      scope,
      sourceId: older.id,
      kind: "fact",
      text: "The observatory project stored an older lantern.",
      createdAt: "2026-10-28T00:00:00.000Z",
    });
    const notebookItem = f.knowledge.addDistilled({
      scope,
      sourceId: other.id,
      kind: "fact",
      text: "In November 2026 the notebook project renamed its index.",
      createdAt: "2026-11-11T00:00:00.000Z",
    }).item;
    f.knowledge.addDistilled({
      scope: "personal",
      sourceId: foreign.id,
      kind: "fact",
      text: "The personal note must not enter the observatory journal.",
      createdAt: "2026-11-11T00:00:00.000Z",
    });
    const rejectedSource = capture(
      f.sources,
      "rejected",
      "Rejected observatory note.",
      "2026-11-11T02:00:00.000Z",
    );
    const rejected = f.knowledge.addDistilled({
      scope,
      sourceId: rejectedSource.id,
      kind: "fact",
      text: "The observatory project rejected the spare dome panel.",
      createdAt: "2026-11-11T02:00:00.000Z",
    }).item;
    const reviews = new DatabaseSync(f.path);
    reviews
      .prepare(
        `INSERT INTO knowledge_reviews
          (id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
         VALUES ('reject-panel', ?, ?, 'rejected', '[]', '{}', '{}', '2026-11-11T03:00:00.000Z')`,
      )
      .run(rejected.id, scope);
    reviews.close();
    let calls = 0;
    const dry = await runTidy({
      databasePath: f.path,
      areas: [scope, "personal"],
      now,
      timeZone: "UTC",
      dryRun: true,
      llm: {
        model: "fake",
        async ask() {
          calls++;
          throw new Error("journal must not call the processor");
        },
      },
    });
    assert.equal(dry.journals, 0);
    assert.equal(dry.distillCalls, 0);
    assert.equal(calls, 0);
    assert.equal(
      f.knowledge.find(journalId("observatory", "2026-W46"), scope),
      undefined,
    );
    const first = await runTidy({
      databasePath: f.path,
      areas: [scope, "personal"],
      now,
      timeZone: "UTC",
    });
    assert.equal(first.distillCalls, 0);
    assert.equal(first.journals, 3);
    const currentJournal = f.knowledge.find(
      journalId("observatory", "2026-W46"),
      scope,
    );
    const previousJournal = f.knowledge.find(
      journalId("observatory", "2026-W45"),
      scope,
    );
    const notebookJournal = f.knowledge.find(
      journalId("notebook", "2026-W46"),
      scope,
    );
    assert.equal(currentJournal?.kind, "journal");
    assert.equal(currentJournal?.text.includes(currentItem.id), false);
    assert.equal(currentJournal?.text.includes("cobalt mirror mount"), true);
    assert.equal(currentJournal?.text.includes("…"), false);
    assert.deepEqual(
      f.knowledge.journalCitations(currentJournal?.id ?? "")?.citedIds,
      [currentItem.id],
    );
    assert.equal(
      f.knowledge
        .journalCitations(currentJournal?.id ?? "")
        ?.citedIds.includes(previousItem.id),
      false,
    );
    assert.equal(currentJournal?.text.includes(notebookItem.id), false);
    assert.equal(currentJournal?.text.includes("personal note"), false);
    assert.equal(
      f.knowledge
        .journalCitations(currentJournal?.id ?? "")
        ?.citedIds.includes(rejected.id),
      false,
    );
    assert.equal(/\bcomplete\b/i.test(currentJournal?.text ?? ""), false);
    assert.deepEqual(
      f.knowledge.journalCitations(previousJournal?.id ?? "")?.citedIds,
      [previousItem.id],
    );
    assert.deepEqual(
      f.knowledge.journalCitations(notebookJournal?.id ?? "")?.citedIds,
      [notebookItem.id],
    );
    assert.equal(
      f.knowledge.find(journalId("observatory", "2026-W44"), scope),
      undefined,
    );
    assert.equal(
      f.knowledge
        .relations(scope)
        .some(
          (link) =>
            link.kind === "supersedes" && link.fromId.startsWith("journal:"),
        ),
      false,
    );
    const before = new DatabaseSync(f.path, { readOnly: true });
    const rowid = before
      .prepare("SELECT rowid FROM knowledge_items WHERE id = ?")
      .get(currentJournal?.id) as { rowid: number };
    before.close();
    const again = await runTidy({
      databasePath: f.path,
      areas: [scope, "personal"],
      now,
      timeZone: "UTC",
    });
    assert.equal(again.journals, 0);
    const reread = new DatabaseSync(f.path, { readOnly: true });
    assert.equal(
      (
        reread
          .prepare("SELECT rowid FROM knowledge_items WHERE id = ?")
          .get(currentJournal?.id) as { rowid: number }
      ).rowid,
      rowid.rowid,
    );
    reread.close();
    const added = capture(
      f.sources,
      "added",
      "Another observatory archive.",
      "2026-11-12T00:00:00.000Z",
    );
    const addedItem = f.knowledge.addDistilled({
      scope,
      sourceId: added.id,
      kind: "fact",
      text: "The observatory project logged a second November note.",
      createdAt: "2026-11-12T00:00:00.000Z",
    }).item;
    const updated = await runTidy({
      databasePath: f.path,
      areas: [scope, "personal"],
      now,
      timeZone: "UTC",
    });
    assert.equal(updated.journals, 1);
    const rewritten = f.knowledge.find(
      journalId("observatory", "2026-W46"),
      scope,
    );
    assert.equal(rewritten?.id, currentJournal?.id);
    assert.equal(rewritten?.text.includes(currentItem.id), false);
    assert.equal(rewritten?.text.includes(addedItem.id), false);
    assert.deepEqual(
      f.knowledge.journalCitations(rewritten?.id ?? "")?.citedIds,
      [currentItem.id, addedItem.id],
    );
    assert.equal(rewritten?.text.includes("cobalt mirror mount"), true);
    assert.equal(rewritten?.text.includes("second November note"), true);
  } finally {
    await f.close();
  }
});

test("a journal paragraph stays within 800 characters and does not spend distill calls", async () => {
  const f = await open("journal-cap");
  try {
    const ids: string[] = [];
    for (const [index, word] of ["alpha", "beta", "gamma"].entries()) {
      const source = capture(
        f.sources,
        `long-${index}`,
        `Archive body ${index}.`,
        `2026-11-1${index}T00:00:00.000Z`,
      );
      ids.push(
        f.knowledge.addDistilled({
          scope,
          sourceId: source.id,
          kind: "fact",
          text: `${word} ${"m".repeat(400 - word.length - 1)}`,
          createdAt: `2026-11-1${index}T00:00:00.000Z`,
        }).item.id,
      );
    }
    let calls = 0;
    const capped = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      distillCallCap: 1,
      llm: {
        model: "fake",
        async ask() {
          calls++;
          return [];
        },
      },
    });
    assert.equal(calls, 0);
    assert.equal(capped.distillCalls, 0);
    assert.equal(capped.journals, 1);
    const journal = f.knowledge.find(
      journalId("observatory", "2026-W46"),
      scope,
    );
    assert.ok(journal);
    assert.equal([...journal.text].length <= journalCharacterLimit, true);
    assert.equal(journal.text.includes("…"), false);
    assert.equal(journal.text.endsWith("."), true);
    for (const id of ids) assert.equal(journal.text.includes(id), false);
    assert.deepEqual(f.knowledge.journalCitations(journal.id)?.citedIds, [
      ids[0],
    ]);
    assert.equal(journal.text.includes("beta"), false);
    assert.equal(journal.text.includes("gamma"), false);
    const extra = capture(
      f.sources,
      "extra",
      "Extra archive.",
      "2026-11-13T00:00:00.000Z",
    );
    const delta = f.knowledge.addDistilled({
      scope,
      sourceId: extra.id,
      kind: "fact",
      text: "The observatory logged a second November note.",
      createdAt: "2026-11-13T00:00:00.000Z",
    }).item;
    const refreshed = f.knowledge.refreshJournals({
      areas: [scope],
      now,
      timeZone: "UTC",
      dryRun: false,
    });
    assert.equal(refreshed.written, 1);
    const updated = f.knowledge.find(journal.id, scope);
    assert.ok(updated);
    assert.equal([...updated.text].length <= journalCharacterLimit, true);
    assert.equal(updated.text.includes(delta.id), false);
    assert.equal(updated.text.includes("second November note"), true);
    assert.equal(updated.text.includes("…"), false);
    assert.deepEqual(f.knowledge.journalCitations(journal.id)?.citedIds, [
      ids[0],
      delta.id,
    ]);
    const kept = new DatabaseSync(f.path, { readOnly: true });
    const row = kept
      .prepare("SELECT rowid FROM knowledge_items WHERE id = ?")
      .get(journal.id) as { rowid: number };
    kept.close();
    assert.equal(
      f.knowledge.refreshJournals({
        areas: [scope],
        now,
        timeZone: "UTC",
        dryRun: false,
      }).written,
      0,
    );
    const reread = new DatabaseSync(f.path, { readOnly: true });
    assert.equal(
      (
        reread
          .prepare("SELECT rowid FROM knowledge_items WHERE id = ?")
          .get(journal.id) as { rowid: number }
      ).rowid,
      row.rowid,
    );
    reread.close();
  } finally {
    await f.close();
  }
});

test("project search reads the journal by id and keeps area-wide results unchanged", async () => {
  const f = await open("journal-search");
  const mcp = createContextMcp(f.sources, ["personal", scope], false, {
    knowledge: f.knowledge,
  });
  const client = new Client({ name: "journal-search", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  try {
    const cited = capture(
      f.sources,
      "cited",
      "Pull request archive. diff hunk discussion continues below.",
      "2026-11-09T00:00:00.000Z",
    );
    capture(
      f.sources,
      "later",
      "A Wednesday observatory log that is not distilled.",
      "2026-11-11T00:00:00.000Z",
    );
    const item = f.knowledge.addDistilled({
      scope,
      sourceId: cited.id,
      kind: "fact",
      text: "In November 2026 the observatory project shipped the cobalt mirror mount.",
      createdAt: "2026-11-09T00:00:00.000Z",
    }).item;
    await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
    });
    const id = journalId("observatory", "2026-W46");
    const read = await client.callTool({
      name: "read",
      arguments: { scope, id },
    });
    const record = read.structuredContent as {
      item?: { kind: string; text: string };
      associations?: { projectId?: string; status: string }[];
    };
    assert.equal(record.item?.kind, "journal");
    assert.equal(record.item?.text.includes(item.id), false);
    assert.equal(record.item?.text.includes("cobalt mirror mount"), true);
    assert.deepEqual(
      (read.structuredContent as { citations?: { citedIds: string[] } })
        .citations?.citedIds,
      [item.id],
    );
    assert.equal(
      record.associations?.some(
        (link) => link.projectId === "observatory" && link.status === "linked",
      ),
      true,
    );
    const call = (args: Record<string, unknown>) =>
      client.callTool({
        name: "search",
        arguments: { scope, ...args },
      });
    const project = await call({
      project: "observatory",
      query: "cobalt mirror",
      since: "2026-11-11T00:00:00.000Z",
      until: "2026-11-16T00:00:00.000Z",
    });
    const body = project.structuredContent as {
      items: {
        id: string;
        kind: string;
        excerpt: { text: string };
        citedIds?: string[];
      }[];
      sources: { excerpt: { text: string } }[];
    };
    assert.equal(body.items[0]?.kind, "journal");
    assert.equal(body.items[0]?.id, id);
    assert.deepEqual(body.items[0]?.citedIds, [item.id]);
    assert.equal(body.items[0]?.excerpt.text.includes(item.id), false);
    assert.equal(body.items[0]?.excerpt.text.includes("…"), false);
    assert.equal(
      body.items.some((entry) => entry.kind === "fact"),
      false,
    );
    assert.equal(JSON.stringify(body).includes("diff hunk discussion"), false);
    const month = await call({
      project: "observatory",
      query: "cobalt mirror",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-12-01T00:00:00.000Z",
    });
    const monthItems = (
      month.structuredContent as { items: { kind: string }[] }
    ).items;
    assert.equal(monthItems[0]?.kind, "journal");
    assert.equal(
      monthItems.some((entry) => entry.kind === "fact"),
      true,
    );
    const area = await call({ query: "cobalt mirror" });
    assert.equal(
      JSON.stringify(area.structuredContent).includes("2026-W46"),
      false,
    );
    assert.equal(
      JSON.stringify(area.structuredContent).includes("journal"),
      false,
    );
    const outside = await call({
      project: "observatory",
      query: "cobalt mirror",
      since: "2026-12-01T00:00:00.000Z",
      until: "2027-01-01T00:00:00.000Z",
    });
    assert.equal(
      JSON.stringify(outside.structuredContent).includes(item.id),
      false,
    );
  } finally {
    await client.close();
    await mcp.close();
    await f.close();
  }
});

test("journal backfill summarizes older weeks and does not rewrite them", async () => {
  const f = await open("journal-backfill");
  try {
    const add = (
      key: string,
      kind: "fact" | "decision",
      text: string,
      createdAt: string,
    ) => {
      const source = capture(f.sources, key, `Archive ${key}.`, createdAt);
      return f.knowledge.addDistilled({
        scope,
        sourceId: source.id,
        kind,
        text,
        createdAt,
      }).item;
    };
    add(
      "current",
      "fact",
      "In November the observatory project logged the current week.",
      "2026-11-11T00:00:00.000Z",
    );
    add(
      "previous",
      "fact",
      "In November the observatory project logged the previous week.",
      "2026-11-04T00:00:00.000Z",
    );
    const decision = add(
      "older-decision",
      "decision",
      "Решение: оставить журнал на языке источника.",
      "2026-10-28T00:00:00.000Z",
    );
    const fact = add(
      "older-fact",
      "fact",
      "Факт: починили вход в Matrix в ту же неделю.",
      "2026-10-27T00:00:00.000Z",
    );
    const earlier = add(
      "older-earlier",
      "fact",
      "Факт: записали зеркало в начале недели.",
      "2026-10-26T00:00:00.000Z",
    );
    const ancient = add(
      "ancient",
      "fact",
      "The observatory project stored an older lantern.",
      "2026-10-19T00:00:00.000Z",
    );
    let calls = 0;
    const nightly = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      llm: {
        model: "fake",
        async ask() {
          calls++;
          return [];
        },
      },
    });
    assert.equal(calls, 0);
    assert.equal(nightly.journals, 2);
    assert.equal(
      f.knowledge.find(journalId("observatory", "2026-W44"), scope),
      undefined,
    );
    const first = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      journalBackfillLimit: 1,
    });
    assert.equal(first.journals, 1);
    const week = f.knowledge.find(journalId("observatory", "2026-W44"), scope);
    assert.ok(week);
    assert.equal([...week.text].length <= journalCharacterLimit, true);
    assert.equal(week.text.includes(decision.id), false);
    assert.equal(week.text.includes(fact.id), false);
    assert.equal(week.text.includes(earlier.id), false);
    assert.equal(week.text.includes("…"), false);
    assert.deepEqual(f.knowledge.journalCitations(week.id)?.citedIds, [
      decision.id,
      earlier.id,
      fact.id,
    ]);
    assert.equal(
      week.text.indexOf("Решение: оставить журнал") <
        week.text.indexOf("починили вход в Matrix"),
      true,
    );
    assert.equal(week.text.includes("Решение: оставить журнал"), true);
    assert.equal(week.text.includes("починили вход в Matrix"), true);
    assert.equal(
      f.knowledge.find(journalId("observatory", "2026-W43"), scope),
      undefined,
    );
    const second = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      journalBackfillLimit: 1,
    });
    assert.equal(second.journals, 1);
    assert.deepEqual(
      f.knowledge.journalCitations(journalId("observatory", "2026-W43"))
        ?.citedIds,
      [ancient.id],
    );
    const rowDb = new DatabaseSync(f.path, { readOnly: true });
    const row = rowDb
      .prepare("SELECT rowid, text FROM knowledge_items WHERE id = ?")
      .get(week.id) as { rowid: number; text: string };
    rowDb.close();
    const third = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      journalBackfillLimit: 1,
    });
    assert.equal(third.journals, 0);
    const kept = new DatabaseSync(f.path, { readOnly: true });
    const after = kept
      .prepare("SELECT rowid, text FROM knowledge_items WHERE id = ?")
      .get(week.id) as { rowid: number; text: string };
    kept.close();
    assert.equal(after.rowid, row.rowid);
    assert.equal(after.text, row.text);
    await assert.rejects(
      () =>
        runTidy({
          databasePath: f.path,
          areas: [scope],
          now,
          timeZone: "UTC",
          journalBackfillLimit: 0,
        }),
      /Invalid journal backfill limit/,
    );
  } finally {
    await f.close();
  }
});

test("journal backfill regenerates an older paragraph and nightly tidy leaves it", async () => {
  const f = await open("journal-rebuild");
  try {
    const source = capture(
      f.sources,
      "ancient",
      "Observatory archive from an older week.",
      "2026-10-19T00:00:00.000Z",
    );
    const item = f.knowledge.addDistilled({
      scope,
      sourceId: source.id,
      kind: "fact",
      text: "The observatory project stored an older lantern.",
      createdAt: "2026-10-19T00:00:00.000Z",
    }).item;
    const seeded = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      journalBackfillLimit: 1,
    });
    assert.equal(seeded.journals, 1);
    const id = journalId("observatory", "2026-W43");
    const stale = `observatory 2026-W43: The observatory project stored an older lantern (${item.id})…`;
    const db = new DatabaseSync(f.path);
    db.prepare("UPDATE knowledge_items SET text = ? WHERE id = ?").run(
      stale,
      id,
    );
    db.close();
    const nightly = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
    });
    assert.equal(nightly.journals, 0);
    assert.equal(f.knowledge.find(id, scope)?.text, stale);
    const rebuilt = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      journalBackfillLimit: 1,
    });
    assert.equal(rebuilt.journals, 1);
    const week = f.knowledge.find(id, scope);
    assert.equal(week?.text.includes(item.id), false);
    assert.equal(week?.text.includes("…"), false);
    assert.equal(week?.text.includes("older lantern"), true);
    assert.equal(week?.text.endsWith("."), true);
    assert.deepEqual(f.knowledge.journalCitations(id)?.citedIds, [item.id]);
    const again = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      journalBackfillLimit: 1,
    });
    assert.equal(again.journals, 0);
    assert.equal(f.knowledge.find(id, scope)?.text, week?.text);
  } finally {
    await f.close();
  }
});

test("journal backfill finishes without distilling and the next pass picks up new items", async () => {
  const f = await open("journal-backfill-pass");
  let asks = 0;
  const blocking = {
    model: "fake",
    async preflight() {
      asks++;
      throw new Error("login");
    },
    async ask() {
      asks++;
      throw new Error("should not distill during backfill");
    },
  };
  try {
    const existingSource = capture(
      f.sources,
      "older-existing",
      "Archive of the older week.",
      "2026-10-28T00:00:00.000Z",
    );
    const existing = f.knowledge.addDistilled({
      scope,
      sourceId: existingSource.id,
      kind: "fact",
      text: "The observatory project stored the older week lantern.",
      createdAt: "2026-10-28T00:00:00.000Z",
    }).item;
    capture(
      f.sources,
      "older-pending",
      "Archive pending lantern source for the older week.",
      "2026-10-27T00:00:00.000Z",
    );
    capture(
      f.sources,
      "current-pending",
      "Archive pending lantern source for the current week.",
      "2026-11-11T00:00:00.000Z",
    );
    const options = {
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      journalBackfill: true,
      llm: blocking,
    };
    const first = await runTidy(options);
    assert.equal(asks, 0);
    assert.equal(first.distillStatus, "skipped_backfill");
    assert.equal(first.distillCalls, 0);
    assert.equal(first.journals, 1);
    assert.equal(first.outcome, "completed");
    const weekId = journalId("observatory", "2026-W44");
    assert.equal(
      f.knowledge.find(weekId, scope)?.text.includes("older week lantern"),
      true,
    );
    const second = await runTidy(options);
    assert.equal(asks, 0);
    assert.equal(second.journals, 0);
    assert.equal(second.outcome, "completed");
    const distilled = await runTidy({
      databasePath: f.path,
      areas: [scope],
      now,
      timeZone: "UTC",
      llm: {
        model: "fake",
        async ask(_instruction: string, data: unknown) {
          asks++;
          const batch = data as { index: number; date: string }[];
          return batch.map((item) => ({
            index: item.index,
            kind: "fact",
            text: item.date.startsWith("2026-11")
              ? "The observatory project logged a current week lantern."
              : "The observatory project logged a late lantern in the older week.",
            project: null,
          }));
        },
      },
    });
    assert.equal(asks, 1);
    assert.equal(distilled.distilled, 2);
    assert.equal(
      f.knowledge.find(weekId, scope)?.text.includes("late lantern"),
      false,
    );
    assert.equal(
      f.knowledge
        .find(journalId("observatory", "2026-W46"), scope)
        ?.text.includes("current week lantern"),
      true,
    );
    const caughtUp = await runTidy(options);
    assert.equal(asks, 1);
    assert.equal(caughtUp.journals, 1);
    assert.equal(
      f.knowledge.find(weekId, scope)?.text.includes("late lantern"),
      true,
    );
    assert.ok(
      f.knowledge.journalCitations(weekId)?.citedIds.includes(existing.id),
    );
    const done = await runTidy(options);
    assert.equal(done.journals, 0);
    assert.equal(asks, 1);
  } finally {
    await f.close();
  }
});
