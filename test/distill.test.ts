import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { buildContextPackage } from "../src/context-package.js";
import {
  clipText,
  copiesStoredBody,
  DISTILL_BODY_LIMIT,
  sourceBody,
} from "../src/distill.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";
import { runTidy } from "../src/tidy.js";

const phrase = "diff hunk discussion ";

async function open(name: string) {
  const directory = await mkdtemp(join(process.cwd(), `.output-${name}-`));
  const path = join(directory, "db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
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

test("an 80 character body span is a copy and 79 characters is not", () => {
  const body = "abcdefghij".repeat(8);
  assert.equal(body.length, 80);
  assert.equal(copiesStoredBody(body, body), true);
  assert.equal(copiesStoredBody(body.slice(0, 79), body), false);
  assert.equal(copiesStoredBody(`note ${body} end`, `xx${body}yy`), true);
  const title = "T".repeat(90);
  assert.equal(sourceBody(`${title}\n\n${body}`, title), body);
  assert.equal(
    clipText(`${"a".repeat(2000)}TAIL`, DISTILL_BODY_LIMIT).length,
    DISTILL_BODY_LIMIT,
  );
  assert.equal(
    clipText(`${"a".repeat(2000)}TAIL`, DISTILL_BODY_LIMIT).includes("TAIL"),
    false,
  );
});

test("GitHub distillation stores one proposed sentence and rejects a body copy", async () => {
  const f = await open("distill-github");
  const prompts: unknown[] = [];
  let rejectWeak = true;
  const title = "T".repeat(90);
  const tail = "ENDMARKER-NOT-IN-PROMPT";
  const body = `${phrase.repeat(80).slice(0, 1600)}${tail} workshoptoken`;
  try {
    f.sources.createProject({
      id: "observatory",
      name: "Fictional Observatory",
      homeArea: "workshop",
    });
    f.sources.createProject({
      id: "notebook",
      name: "Fictional Notebook",
      homeArea: "workshop",
    });
    f.sources.createProject({
      id: "kept",
      name: "Kept",
      homeArea: "workshop",
    });
    f.sources.mapRepository("fictional/observatory", "observatory");
    const imported = (
      label: string,
      text: string,
      externalId: string,
      repo?: string,
    ) =>
      f.sources.importMaterial(
        {
          version: 1,
          text,
          origin: "import:github",
          scope: "workshop",
          idempotencyKey: "import",
          metadata: {
            type: "document",
            title: label,
            createdAt: "2026-10-04T00:00:00Z",
            sourceUri: `https://example.invalid/fictional/${externalId}`,
          },
        },
        {
          source: "github",
          externalId,
          kind: "pr",
          metadata: repo ? { repo } : {},
        },
      ).source;
    const mirror = imported(
      "Ship the cobalt mirror",
      `Ship the cobalt mirror\n\n${body}`,
      "mirror",
      "fictional/observatory",
    );
    f.sources.addClientAssociation("source", mirror.id, ["kept"]);
    const copied = imported(
      "Archive the hatch notes",
      `Archive the hatch notes\n\n${body}`,
      "copied",
    );
    const annex = imported(
      "Annex log",
      "Annex log\n\nA short fictional annex log.",
      "annex",
    );
    const titled = imported(title, `${title}\n\n${phrase.repeat(6)}`, "titled");
    const broken = imported(
      "Broken card",
      "Broken card\n\nA fictional card with no usable sentence yet.",
      "broken",
    );
    const before = [mirror, copied, annex, titled, broken].map((source) => ({
      id: source.id,
      checksum: source.checksum,
      text: source.text,
    }));
    const llm = {
      model: "fake",
      async ask(_instruction: string, data: unknown) {
        prompts.push(data);
        return (data as { index: number; title: string | null }[]).map(
          (source) => {
            if (source.title === "Ship the cobalt mirror")
              return {
                index: source.index,
                kind: "fact",
                text: "In October 2026 the observatory project kept the cobalt mirror mount.",
                project: "notebook",
                status: "approved",
                supersedes: ["not-a-real-id"],
              };
            if (source.title === "Archive the hatch notes")
              return rejectWeak
                ? {
                    index: source.index,
                    kind: "fact",
                    text: phrase.repeat(4),
                    project: null,
                  }
                : {
                    index: source.index,
                    kind: "fact",
                    text: "The workshop archived the hatch notes.",
                    project: null,
                  };
            if (source.title === "Annex log")
              return {
                index: source.index,
                kind: "decision",
                text: "A fictional annex log records one synthetic decision.",
                project: "Fictional Annex",
                status: "approved",
              };
            if (source.title === title)
              return {
                index: source.index,
                kind: "fact",
                text: `${title} is a fictional ship note.`,
                project: null,
              };
            return rejectWeak
              ? { index: source.index, text: "missing kind" }
              : {
                  index: source.index,
                  kind: "fact",
                  text: "A broken card became a fictional note.",
                  project: null,
                };
          },
        );
      },
    };
    const options = {
      databasePath: f.path,
      areas: ["workshop"],
      llm,
    };
    const dry = await runTidy({ ...options, dryRun: true });
    assert.equal(dry.distilled, 3);
    assert.equal(dry.distillRejected, 2);
    assert.equal(dry.dryRun, true);
    assert.equal(f.knowledge.list("workshop", 20).length, 0);
    await assert.rejects(readFile(join(f.directory, "tidy/history.jsonl")));
    const first = await runTidy(options);
    assert.equal(first.distilled, 3);
    assert.equal(first.distillRejected, 2);
    assert.equal(first.distillCalls, 1);
    assert.equal(first.outcome, "completed");
    const sent = prompts[0] as {
      title: string | null;
      projects: string[];
      url: string | null;
      date: string;
      kind: string | null;
      body: string;
    }[];
    const mirrorPrompt = sent.find(
      (source) => source.title === "Ship the cobalt mirror",
    );
    assert.deepEqual(mirrorPrompt?.projects, ["kept", "observatory"]);
    assert.equal(mirrorPrompt?.kind, "pr");
    assert.equal(mirrorPrompt?.date, "2026-10-04T00:00:00Z");
    assert.equal(mirrorPrompt?.url, "https://example.invalid/fictional/mirror");
    assert.ok((mirrorPrompt?.body.length ?? 0) <= DISTILL_BODY_LIMIT);
    assert.equal(mirrorPrompt?.body.includes(tail), false);
    assert.ok(sent.every((source) => source.body.length <= DISTILL_BODY_LIMIT));
    const items = f.knowledge.list("workshop", 20);
    assert.equal(items.length, 3);
    const fact = items.find((item) => item.text.includes("cobalt"));
    assert.equal(fact?.kind, "fact");
    assert.equal(fact?.status, "proposed");
    assert.equal(fact?.createdAt, "2026-10-04T00:00:00Z");
    assert.deepEqual(fact?.sourceRefs, [{ sourceId: mirror.id }]);
    assert.equal(fact?.creator.name, "context-tidy");
    assert.deepEqual(f.sources.associationsFor("knowledge", fact?.id ?? ""), [
      { projectId: "kept", origin: "client", status: "linked" },
      { projectId: "notebook", origin: "proposed", status: "proposed" },
      { projectId: "observatory", origin: "configured", status: "linked" },
    ]);
    assert.deepEqual(f.sources.associationsFor("source", mirror.id), [
      { projectId: "kept", origin: "client", status: "linked" },
      { projectId: "observatory", origin: "configured", status: "linked" },
    ]);
    const decision = items.find((item) => item.kind === "decision");
    assert.equal(decision?.status, "proposed");
    assert.deepEqual(
      f.sources.associationsFor("knowledge", decision?.id ?? ""),
      [
        {
          origin: "proposed",
          status: "proposed",
          suggestedName: "Fictional Annex",
        },
      ],
    );
    assert.ok(items.some((item) => item.text.includes(title)));
    assert.equal(
      items.some((item) => item.sourceRefs[0]?.sourceId === copied.id),
      false,
    );
    assert.equal(
      f.knowledge
        .relations("workshop")
        .some((link) => link.kind === "supersedes"),
      false,
    );
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(
        Number(
          db.prepare("SELECT COUNT(*) AS n FROM knowledge_reviews").get()?.n,
        ),
        0,
      );
    } finally {
      db.close();
    }
    for (const source of before) {
      const current = f.sources.find(source.id, "workshop");
      assert.equal(current?.checksum, source.checksum);
      assert.equal(current?.text, source.text);
    }
    const pack = buildContextPackage(f.sources, f.knowledge, {
      version: 1,
      scope: "workshop",
      question: "workshoptoken diff hunk discussion",
    });
    assert.ok(pack.sources.some((card) => card.id === mirror.id));
    assert.ok(
      pack.sources.some((card) =>
        card.excerpt.text.includes("diff hunk discussion"),
      ),
    );
    assert.equal(
      pack.items.some(
        (card) => card.kind === "fact" || card.kind === "decision",
      ),
      false,
    );
    const narrowed = f.sources.packageCandidates({
      scope: "workshop",
      terms: ["workshoptoken"],
      limit: 10,
      projectId: "observatory",
    });
    assert.deepEqual(
      narrowed.materials.map((material) => material.source.id),
      [mirror.id],
    );
    assert.equal(
      f.knowledge.packageCandidates(
        { scope: "workshop", terms: ["cobalt"], limit: 10 },
        [],
      ).items.length,
      0,
    );
    assert.equal(
      f.knowledge.packageCandidates(
        { scope: "workshop", terms: [], limit: 10 },
        [mirror.id],
      ).items.length,
      0,
    );
    rejectWeak = false;
    const second = await runTidy(options);
    assert.equal(second.distilled, 2);
    assert.equal(f.knowledge.list("workshop", 20).length, 5);
    const third = await runTidy(options);
    assert.equal(third.distillCalls, 0);
    assert.equal(third.distilled, 0);
    assert.equal(f.knowledge.list("workshop", 20).length, 5);
    assert.equal(
      f.knowledge
        .relations("workshop")
        .some((link) => link.kind === "supersedes"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("distillation caps resume from a cursor without duplicating sentences", async () => {
  const f = await open("distill-cap");
  const seen: string[][] = [];
  try {
    await assert.rejects(
      () =>
        runTidy({
          databasePath: f.path,
          areas: ["personal"],
          distillBatchSize: 9,
        }),
      /Invalid distillation cap/,
    );
    const checksums = new Map<string, string>();
    for (let index = 0; index < 5; index++) {
      const source = f.sources.captureMaterial({
        version: 1,
        scope: "personal",
        origin: "fixture",
        idempotencyKey: `note-${index}`,
        text: `Body ${index} ${"q".repeat(90)}`,
        metadata: { title: `note-${index}`, createdAt: "2026-03-01T00:00:00Z" },
      }).material.source;
      checksums.set(source.id, source.checksum);
    }
    const options = {
      databasePath: f.path,
      areas: ["personal"],
      distillBatchSize: 2,
      distillCallCap: 1,
      llm: {
        model: "fake",
        async ask(_instruction: string, data: unknown) {
          const batch = data as { index: number; title: string | null }[];
          seen.push(batch.map((source) => source.title ?? ""));
          assert.ok(batch.length <= 2);
          return batch.map((source) => ({
            index: source.index,
            kind: "fact",
            text: `Synthetic fact ${source.title}`,
            project: null,
            status: "approved",
            supersedes: ["ghost"],
          }));
        },
      },
    };
    const first = await runTidy(options);
    assert.deepEqual(seen, [["note-0", "note-1"]]);
    assert.equal(first.distilled, 2);
    assert.equal(first.distillCalls, 1);
    assert.equal(first.distillCapped, true);
    assert.equal(typeof first.distillAfter, "number");
    const second = await runTidy(options);
    assert.deepEqual(seen[1], ["note-2", "note-3"]);
    assert.equal(second.distilled, 2);
    const third = await runTidy(options);
    assert.deepEqual(seen[2], ["note-4"]);
    assert.equal(third.distillCapped, false);
    assert.equal(third.distillAfter, null);
    const fourth = await runTidy(options);
    assert.equal(fourth.distillCalls, 0);
    assert.equal(fourth.distilled, 0);
    assert.equal(seen.length, 3);
    const items = f.knowledge.list("personal", 20);
    assert.equal(items.length, 5);
    assert.ok(items.every((item) => item.status === "proposed"));
    assert.equal(
      f.knowledge
        .relations("personal")
        .some((link) => link.kind === "supersedes"),
      false,
    );
    for (const [id, checksum] of checksums)
      assert.equal(f.sources.find(id, "personal")?.checksum, checksum);
    const history = await readFile(
      join(f.directory, "tidy/history.jsonl"),
      "utf8",
    );
    assert.equal(history.includes("note-0"), false);
    assert.equal(history.includes("qqqq"), false);
    assert.equal(JSON.parse(history.split("\n")[0] ?? "").distillCapped, true);
  } finally {
    await f.close();
  }
});

test("a later source revision gets its own proposed item and does not supersede", async () => {
  const f = await open("distill-revision");
  try {
    f.sources.createProject({
      id: "observatory",
      name: "Fictional Observatory",
      homeArea: "workshop",
    });
    f.sources.mapRepository("fictional/observatory", "observatory");
    const line = (text: string) =>
      f.sources.importMaterial(
        {
          version: 1,
          text: `Ship the mount\n\n${text}`,
          origin: "import:github",
          scope: "workshop",
          idempotencyKey: "import",
          metadata: {
            title: "Ship the mount",
            createdAt: "2026-10-04T00:00:00Z",
          },
        },
        {
          source: "github",
          externalId: "mount",
          kind: "pr",
          metadata: { repo: "fictional/observatory" },
        },
      );
    const first = line("The fictional observatory drafted the mount.");
    const llm = {
      model: "fake",
      async ask(_instruction: string, data: unknown) {
        return (data as { index: number; body: string }[]).map((source) => ({
          index: source.index,
          kind: "decision",
          text: `The observatory project recorded: ${source.body.slice(0, 40)}`,
          project: null,
        }));
      },
    };
    const options = { databasePath: f.path, areas: ["workshop"], llm };
    assert.equal((await runTidy(options)).distilled, 1);
    const revised = line("The fictional observatory shipped the mount.");
    assert.equal(revised.changed, true);
    assert.notEqual(revised.source.id, first.source.id);
    assert.equal((await runTidy(options)).distilled, 1);
    const items = f.knowledge.list("workshop", 20);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.sourceRefs[0]?.sourceId).sort(),
      [first.source.id, revised.source.id].sort(),
    );
    assert.ok(items.every((item) => item.status === "proposed"));
    assert.equal(
      f.knowledge
        .relations("workshop")
        .some((link) => link.kind === "supersedes"),
      false,
    );
    assert.equal(
      f.sources.find(first.source.id, "workshop")?.checksum,
      first.source.checksum,
    );
  } finally {
    await f.close();
  }
});

test("an unavailable processor skips distillation and still deduplicates", async () => {
  const text =
    "Synthetic lunar garden maintenance records describe watering schedules and seasonal observations.";
  const f = await open("distill-down");
  let asks = 0;
  try {
    const older = f.sources.captureMaterial({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "older",
      text,
      metadata: { createdAt: "2026-01-01T00:00:00Z" },
    }).material.source;
    const newer = f.sources.captureMaterial({
      version: 1,
      scope: "personal",
      origin: "fixture",
      idempotencyKey: "newer",
      text,
      metadata: { createdAt: "2026-01-02T00:00:00Z" },
    }).material.source;
    const expired = await runTidy({
      databasePath: f.path,
      areas: ["personal"],
      llm: {
        model: "fake",
        async preflight() {
          throw new Error("login expired");
        },
        async ask() {
          asks++;
          throw new Error("should not ask");
        },
      },
    });
    assert.equal(asks, 0);
    assert.equal(expired.llm, "unavailable");
    assert.equal(expired.distillStatus, "skipped_unavailable");
    assert.equal(expired.distillCalls, 0);
    assert.equal(expired.duplicates, 1);
    assert.equal(expired.outcome, "partial");
    assert.equal(f.knowledge.list("personal", 20).length, 0);
    assert.equal(
      f.sources.find(older.id, "personal")?.checksum,
      older.checksum,
    );
    assert.equal(
      f.sources.find(newer.id, "personal")?.checksum,
      newer.checksum,
    );
    const failed = await runTidy({
      databasePath: f.path,
      areas: ["personal"],
      llm: {
        model: "fake",
        async ask() {
          throw new Error("timeout");
        },
      },
    });
    assert.equal(failed.distillCalls, 1);
    assert.equal(failed.llm, "unavailable");
    assert.equal(failed.distillStatus, "skipped_unavailable");
    assert.equal(failed.duplicates, 0);
    assert.equal(failed.outcome, "partial");
    assert.equal(f.knowledge.list("personal", 20).length, 0);
    const plain = await runTidy({
      databasePath: f.path,
      areas: ["personal"],
    });
    assert.equal(plain.distillStatus, "skipped_not_configured");
    assert.equal(plain.distillCalls, 0);
    assert.equal(plain.outcome, "completed");
    assert.equal(plain.duplicates, 0);
  } finally {
    await f.close();
  }
});

test("requests redact stored secrets and a later inbox move keeps the distilled item", async () => {
  const f = await open("distill-move");
  let routing = 0.5;
  try {
    f.sources.insert({
      id: "raw-secret",
      text: "Synthetic note sk-proj-abcdefghijklmnopqrstuvwxyz for the workshop.",
      origin: "fixture",
      scope: "workshop",
      capturedAt: "2026-05-01T00:00:00Z",
    });
    const secret = f.sources.find("raw-secret", "workshop");
    let sawRedaction = false;
    await runTidy({
      databasePath: f.path,
      areas: ["workshop"],
      llm: {
        model: "fake",
        async ask(_instruction: string, data: unknown) {
          const encoded = JSON.stringify(data);
          assert.equal(
            encoded.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"),
            false,
          );
          assert.equal(encoded.includes("[REDACTED]"), true);
          sawRedaction = true;
          return [
            {
              index: 0,
              kind: "fact",
              text: "A synthetic workshop note mentioned a redacted token.",
              project: null,
            },
          ];
        },
      },
    });
    assert.equal(sawRedaction, true);
    assert.equal(
      f.sources.find("raw-secret", "workshop")?.checksum,
      secret?.checksum,
    );
    const inbox = f.sources.capture({
      version: 1,
      text: "Synthetic garden routing confident",
      origin: "fixture",
      scope: "inbox",
      idempotencyKey: "inbox-note",
    }).source;
    const checksum = inbox.checksum;
    const llm = {
      model: "fake",
      async ask(instruction: string, data: unknown) {
        if (instruction.startsWith("Distill"))
          return (data as { index: number }[]).map((source) => ({
            index: source.index,
            kind: "fact",
            text: "A synthetic inbox note stayed for later routing.",
            project: null,
          }));
        return (data as { index: number }[]).map((source) => ({
          index: source.index,
          area: "personal",
          confidence: routing,
        }));
      },
    };
    const held = await runTidy({
      databasePath: f.path,
      areas: ["inbox", "personal", "workshop"],
      llm,
    });
    assert.equal(held.moved, 0);
    assert.equal(held.uncertain, 1);
    const proposed = f.knowledge
      .list("inbox", 20)
      .find((item) => item.text.includes("routing"));
    assert.equal(proposed?.status, "proposed");
    routing = 1;
    const moved = await runTidy({
      databasePath: f.path,
      areas: ["inbox", "personal", "workshop"],
      llm,
    });
    assert.equal(moved.moved, 1);
    assert.equal(f.sources.find(inbox.id, "inbox"), undefined);
    assert.equal(f.sources.find(inbox.id, "personal")?.checksum, checksum);
    assert.equal(
      f.knowledge.find(proposed?.id ?? "", "personal")?.scope,
      "personal",
    );
    assert.equal(f.knowledge.find(proposed?.id ?? "", "inbox"), undefined);
    assert.equal(
      f.knowledge
        .relations("personal")
        .some((link) => link.kind === "supersedes"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("an old knowledge table gains fact and decision without dropping reviews", async () => {
  const f = await open("distill-migrate");
  try {
    f.sources.insert({
      id: "idea-source",
      text: "Synthetic source for the migrated idea.",
      origin: "fixture",
      scope: "personal",
      capturedAt: "2026-01-01T00:00:00Z",
    });
    f.knowledge.close();
    f.sources.close();
    const db = new DatabaseSync(f.path);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS knowledge_items_fts_insert;
      DROP TRIGGER IF EXISTS knowledge_items_search_insert;
      DROP TRIGGER IF EXISTS knowledge_items_search_delete;
      DROP TABLE IF EXISTS knowledge_items_fts;
      DROP TABLE IF EXISTS knowledge_items_stemmed;
      DROP TABLE knowledge_items;
      CREATE TABLE knowledge_items (
        id TEXT PRIMARY KEY NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('idea', 'observation', 'decision_proposal')),
        text TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        creator TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO knowledge_items (
        id, scope, kind, text, source_refs, creator, created_at
      ) VALUES (
        'idea-1', 'personal', 'idea', 'Synthetic kept idea',
        '[{"sourceId":"idea-source"}]',
        '{"kind":"user","name":"fixture"}',
        '2026-01-01T00:00:00Z'
      );
      INSERT INTO knowledge_reviews (
        id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at
      ) VALUES (
        'rev-1', 'idea-1', 'personal', 'approved', '[]',
        '{"kind":"user","name":"fixture"}', 'receipt', '2026-01-02T00:00:00Z'
      );
    `);
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO knowledge_items (
            id, scope, kind, text, source_refs, creator, created_at
          ) VALUES ('fact-1', 'personal', 'fact', 'nope', '[]', '{}', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    );
    db.close();
    const knowledge = new KnowledgeStore(f.path);
    const sources = new SourceStore(f.path);
    try {
      assert.equal(knowledge.find("idea-1", "personal")?.status, "approved");
      assert.equal(
        knowledge.find("idea-1", "personal")?.text,
        "Synthetic kept idea",
      );
      const saved = knowledge.addDistilled({
        scope: "personal",
        sourceId: "idea-source",
        kind: "fact",
        text: "The personal project kept a migrated sentence.",
        createdAt: "2026-01-01T00:00:00Z",
      });
      assert.equal(saved.item.status, "proposed");
      assert.equal(saved.item.kind, "fact");
      const again = knowledge.addDistilled({
        scope: "personal",
        sourceId: "idea-source",
        kind: "fact",
        text: "The personal project kept a migrated sentence.",
        createdAt: "2026-01-01T00:00:00Z",
      });
      assert.equal(again.duplicate, true);
      assert.equal(again.item.id, saved.item.id);
      const lookup = new DatabaseSync(f.path, { readOnly: true });
      try {
        assert.ok(
          lookup
            .prepare(
              "SELECT rowid FROM knowledge_items_fts WHERE knowledge_items_fts MATCH 'kept'",
            )
            .get(),
        );
      } finally {
        lookup.close();
      }
      assert.equal(
        sources.find("idea-source", "personal")?.text.includes("Synthetic"),
        true,
      );
    } finally {
      knowledge.close();
      sources.close();
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
