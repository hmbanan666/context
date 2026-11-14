import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { buildContextPackage } from "../src/context-package.js";
import { isoWeek } from "../src/journal.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { projectCommand } from "../src/project-cli.js";
import { ReviewInputError, UnknownProposal } from "../src/review.js";
import { SourceStore } from "../src/store.js";

const scope = "workshop";
const weekOf = isoWeek(new Date("2026-11-11T12:00:00.000Z"), "UTC");
const earlier = isoWeek(new Date("2026-11-04T12:00:00.000Z"), "UTC");

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
  project?: string,
) {
  return sources.captureMaterial(
    {
      version: 1,
      scope,
      origin: "synthetic:review",
      idempotencyKey: key,
      text,
      metadata: { createdAt },
    },
    undefined,
    project ? [project] : undefined,
  ).material.source;
}
function distill(
  knowledge: KnowledgeStore,
  sourceId: string,
  kind: "fact" | "decision",
  text: string,
  createdAt: string,
  project?: { projectId?: string; suggestedName?: string },
) {
  return knowledge.addDistilled({
    scope,
    sourceId,
    kind,
    text,
    createdAt,
    ...(project?.projectId ? { proposedProjectId: project.projectId } : {}),
    ...(project?.suggestedName
      ? { suggestedProjectName: project.suggestedName }
      : {}),
  }).item;
}
function supersedes(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_relations WHERE kind = 'supersedes'",
        )
        .get()?.n,
    );
  } finally {
    db.close();
  }
}
function reviews(dbPath: string, knowledgeId: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT status, evidence, reviewer, signed_receipt AS receipt
         FROM knowledge_reviews WHERE knowledge_id = ? ORDER BY rowid`,
      )
      .all(knowledgeId) as {
      status: string;
      evidence: string;
      reviewer: string;
      receipt: string;
    }[];
  } finally {
    db.close();
  }
}
const areas = [scope];
const zone = "UTC";

test("a proposed decision is absent from decisions in force until approval", async () => {
  const f = await open("review-force");
  try {
    const source = capture(
      f.sources,
      "motors",
      "Source for the shutter rule.",
      "2026-11-11T00:00:00.000Z",
      "observatory",
    );
    const pinned = distill(
      f.knowledge,
      source.id,
      "decision",
      "Dome motors stay disabled until the shutter is confirmed closed.",
      "2026-11-11T00:00:00.000Z",
    );
    const checksum = f.sources.find(source.id, scope)?.checksum;
    f.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the fictional observatory dome.",
      rules: "Do not move the dome while the shutter is open.",
      pinned: [pinned.id],
    });
    assert.deepEqual(f.sources.profile("observatory")?.inForce, []);
    assert.equal(f.knowledge.find(pinned.id, scope)?.status, "proposed");
    const before = buildContextPackage(
      f.sources,
      f.knowledge,
      {
        version: 1,
        scope,
        question: "shutter motors",
        mode: "search",
      },
      undefined,
      "observatory",
    );
    assert.equal(before.items[0]?.status, "proposed");
    assert.equal(supersedes(f.path), 0);
    const decided = f.knowledge.decideProposals({
      action: "approved",
      ids: [pinned.id],
      areas,
      timeZone: zone,
    });
    assert.equal(decided.decisions[0]?.changed, true);
    assert.equal(decided.decisions[0]?.status, "approved");
    assert.equal(f.knowledge.find(pinned.id, scope)?.status, "approved");
    assert.deepEqual(f.sources.profile("observatory")?.inForce, [
      {
        id: pinned.id,
        text: "Dome motors stay disabled until the shutter is confirmed closed.",
      },
    ]);
    const after = buildContextPackage(
      f.sources,
      f.knowledge,
      {
        version: 1,
        scope,
        question: "shutter motors",
        mode: "search",
      },
      undefined,
      "observatory",
    );
    assert.equal(after.items[0]?.id, pinned.id);
    assert.equal(after.items[0]?.status, "approved");
    assert.equal(f.sources.find(source.id, scope)?.checksum, checksum);
    assert.equal(supersedes(f.path), 0);
    const row = reviews(f.path, pinned.id);
    assert.equal(row.length, 1);
    assert.equal(row[0]?.evidence, "[]");
    assert.equal(row[0]?.reviewer, "owner");
    assert.equal(row[0]?.receipt, "{}");
    const again = f.knowledge.decideProposals({
      action: "approved",
      ids: [pinned.id],
      areas,
      timeZone: zone,
    });
    assert.equal(again.decisions[0]?.changed, false);
    assert.equal(reviews(f.path, pinned.id).length, 1);
    f.sources.captureMaterial(
      {
        version: 1,
        scope,
        origin: "synthetic:review",
        idempotencyKey: "replace-motors",
        text: "The dome may move after the shutter is confirmed closed.",
        metadata: { createdAt: "2026-11-12T00:00:00.000Z" },
      },
      { ids: [pinned.id], clientId: "owner" },
      ["observatory"],
    );
    assert.equal(supersedes(f.path), 1);
    assert.deepEqual(f.sources.profile("observatory")?.inForce, []);
    assert.deepEqual(f.sources.profile("observatory")?.pinned, [pinned.id]);
  } finally {
    await f.close();
  }
});

test("rejection drops a decision from search and the next journal, and a project audit does not", async () => {
  const f = await open("review-reject");
  try {
    const keptSource = capture(
      f.sources,
      "kept",
      "Observatory archive for the cobalt mirror.",
      "2026-11-11T00:00:00.000Z",
      "observatory",
    );
    const dropSource = capture(
      f.sources,
      "drop",
      "Observatory archive for the spare panel.",
      "2026-11-11T02:00:00.000Z",
      "observatory",
    );
    const kept = distill(
      f.knowledge,
      keptSource.id,
      "fact",
      "In November 2026 the observatory project shipped the cobalt mirror mount.",
      "2026-11-11T00:00:00.000Z",
    );
    const dropped = distill(
      f.knowledge,
      dropSource.id,
      "fact",
      "The observatory project rejected the spare dome panel.",
      "2026-11-11T02:00:00.000Z",
    );
    const loose = capture(
      f.sources,
      "loose",
      "An unlinked fictional note about lanterns.",
      "2026-11-11T03:00:00.000Z",
    );
    const proposed = distill(
      f.knowledge,
      loose.id,
      "fact",
      "The lantern note proposes an observatory link.",
      "2026-11-11T03:00:00.000Z",
      { projectId: "observatory" },
    );
    const now = new Date("2026-11-12T00:00:00.000Z");
    f.knowledge.refreshJournals({
      areas,
      now,
      timeZone: zone,
      dryRun: false,
    });
    const journal = f.knowledge.find(`journal:observatory:${weekOf.id}`, scope);
    assert.equal(journal?.text.includes(kept.id), true);
    assert.equal(journal?.text.includes(dropped.id), true);
    const link = f.knowledge
      .listProposals({ kind: "project" })
      .proposals.find(
        (row) =>
          row.recordId === proposed.id && row.projectId === "observatory",
      );
    assert.ok(link);
    f.knowledge.decideProposals({
      action: "rejected",
      ids: [link.id],
      areas,
      timeZone: zone,
    });
    assert.equal(f.knowledge.find(proposed.id, scope)?.status, "proposed");
    assert.equal(
      f.sources.linkedToProject("knowledge", proposed.id, "observatory"),
      false,
    );
    assert.equal(
      reviews(f.path, proposed.id)[0]?.evidence.includes("project"),
      true,
    );
    f.knowledge.decideProposals({
      action: "rejected",
      ids: [dropped.id],
      areas,
      timeZone: zone,
    });
    assert.equal(f.knowledge.find(dropped.id, scope)?.status, "rejected");
    const searched = buildContextPackage(
      f.sources,
      f.knowledge,
      { version: 1, scope, question: "spare dome panel", mode: "search" },
      undefined,
      "observatory",
    );
    assert.equal(
      searched.items.some((item) => item.id === dropped.id),
      false,
    );
    f.knowledge.refreshJournals({
      areas,
      now,
      timeZone: zone,
      dryRun: false,
    });
    const refreshed = f.knowledge.find(
      `journal:observatory:${weekOf.id}`,
      scope,
    );
    assert.equal(refreshed?.text.includes(dropped.id), false);
    assert.equal(refreshed?.text.includes(kept.id), true);
    assert.equal(supersedes(f.path), 0);
  } finally {
    await f.close();
  }
});

test("approving a suggested name creates the project and a link stays proposed as an item", async () => {
  const f = await open("review-name");
  try {
    const source = capture(
      f.sources,
      "lanterns",
      "A loose fictional note about lanterns.",
      "2026-11-11T04:00:00.000Z",
    );
    const item = distill(
      f.knowledge,
      source.id,
      "decision",
      "The lantern project should track fictional fuel.",
      "2026-11-11T04:00:00.000Z",
      { suggestedName: "Fictional Lanterns" },
    );
    const listed = f.knowledge.listProposals({ kind: "project" });
    const proposal = listed.proposals.find((row) => row.recordId === item.id);
    assert.equal(proposal?.suggestedName, "Fictional Lanterns");
    assert.equal(f.sources.hasProject("lanterns"), false);
    assert.throws(
      () =>
        f.knowledge.decideProposals({
          action: "approved",
          ids: [proposal?.id ?? ""],
          areas,
          timeZone: zone,
        }),
      ReviewInputError,
    );
    assert.equal(f.sources.hasProject("lanterns"), false);
    const decided = f.knowledge.decideProposals({
      action: "approved",
      ids: [proposal?.id ?? ""],
      areas,
      timeZone: zone,
      assign: { id: "lanterns" },
    });
    assert.equal(decided.decisions[0]?.changed, true);
    assert.equal(f.sources.hasProject("lanterns"), true);
    assert.equal(
      f.sources.listProjects().projects.find((row) => row.id === "lanterns")
        ?.homeArea,
      scope,
    );
    assert.equal(
      f.sources.linkedToProject("knowledge", item.id, "lanterns"),
      true,
    );
    assert.equal(f.knowledge.find(item.id, scope)?.status, "proposed");
    assert.equal(
      f.knowledge
        .listProposals({ kind: "project" })
        .proposals.some((row) => row.id === proposal?.id),
      false,
    );
    const found = buildContextPackage(
      f.sources,
      f.knowledge,
      { version: 1, scope, question: "lantern fuel", mode: "search" },
      undefined,
      "lanterns",
    );
    assert.equal(found.items[0]?.id, item.id);
    assert.equal(found.items[0]?.status, "proposed");
    assert.equal(supersedes(f.path), 0);
    const sourceOnly = capture(
      f.sources,
      "shed",
      "A fictional shed note with no distilled item.",
      "2026-11-11T05:00:00.000Z",
    );
    f.sources.proposeProjectLink({
      recordKind: "source",
      recordId: sourceOnly.id,
      sourceId: sourceOnly.id,
      suggestedName: "Fictional Shed",
    });
    const shed = f.knowledge
      .listProposals({ kind: "project" })
      .proposals.find((row) => row.suggestedName === "Fictional Shed");
    assert.equal(shed?.recordKind, "source");
    const before = reviews(f.path, sourceOnly.id);
    f.knowledge.decideProposals({
      action: "approved",
      ids: [shed?.id ?? ""],
      areas,
      timeZone: zone,
      assign: { id: "shed" },
    });
    assert.equal(f.sources.hasProject("shed"), true);
    assert.equal(
      f.sources.linkedToProject("source", sourceOnly.id, "shed"),
      true,
    );
    assert.deepEqual(reviews(f.path, sourceOnly.id), before);
    const db = new DatabaseSync(f.path, { readOnly: true });
    const audit = db
      .prepare(
        "SELECT reviewer, reviewed_at AS reviewedAt FROM project_proposals WHERE id = ?",
      )
      .get(shed?.id) as { reviewer: string; reviewedAt: string };
    db.close();
    assert.equal(audit.reviewer, "owner");
    assert.equal(Number.isFinite(Date.parse(audit.reviewedAt)), true);
  } finally {
    await f.close();
  }
});

test("review list filters by project, kind and date, and bulk approve is scoped", async () => {
  const f = await open("review-bulk");
  try {
    const current = capture(
      f.sources,
      "current",
      "Observatory archive for the current week.",
      "2026-11-11T00:00:00.000Z",
      "observatory",
    );
    const other = capture(
      f.sources,
      "other-day",
      "Observatory archive for the previous week.",
      "2026-11-04T00:00:00.000Z",
      "observatory",
    );
    const notebook = capture(
      f.sources,
      "notebook",
      "Notebook archive for the current week.",
      "2026-11-11T00:00:00.000Z",
      "notebook",
    );
    const first = distill(
      f.knowledge,
      current.id,
      "decision",
      "The observatory project keeps the cobalt mirror covered.",
      "2026-11-11T00:00:00.000Z",
    );
    const second = distill(
      f.knowledge,
      capture(
        f.sources,
        "second",
        "Observatory archive for a second current decision.",
        "2026-11-12T00:00:00.000Z",
        "observatory",
      ).id,
      "fact",
      "The observatory project logged a clear night.",
      "2026-11-12T00:00:00.000Z",
    );
    const previous = distill(
      f.knowledge,
      other.id,
      "decision",
      "The observatory project kept the lantern rule.",
      "2026-11-04T00:00:00.000Z",
    );
    const foreign = distill(
      f.knowledge,
      notebook.id,
      "decision",
      "The notebook project renamed its index.",
      "2026-11-11T00:00:00.000Z",
    );
    f.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the dome.",
      rules: "Keep the shutter closed.",
      pinned: [first.id],
    });
    const pins = f.knowledge.listProposals({
      projectId: "observatory",
      kind: "pin",
      week: weekOf.id,
      timeZone: zone,
    });
    assert.deepEqual(
      pins.proposals.map((row) => row.id),
      [`pin.${first.id}`],
    );
    assert.equal(pins.proposals[0]?.pinned, true);
    const facts = f.knowledge.listProposals({
      projectId: "observatory",
      kind: "fact",
      since: weekOf.start,
      until: weekOf.end,
    });
    assert.deepEqual(
      facts.proposals.map((row) => row.id),
      [second.id],
    );
    const week = f.knowledge.decideProposals({
      action: "approved",
      projectId: "observatory",
      week: weekOf.id,
      areas,
      timeZone: zone,
    });
    assert.deepEqual(
      week.decisions.map((row) => row.id).sort(),
      [first.id, second.id].sort(),
    );
    assert.equal(f.knowledge.find(first.id, scope)?.status, "approved");
    assert.equal(f.knowledge.find(second.id, scope)?.status, "approved");
    assert.equal(f.knowledge.find(previous.id, scope)?.status, "proposed");
    assert.equal(f.knowledge.find(foreign.id, scope)?.status, "proposed");
    assert.equal(f.sources.profile("observatory")?.inForce.length, 1);
    const rejected = f.knowledge.decideProposals({
      action: "rejected",
      ids: [previous.id, foreign.id],
      areas,
      timeZone: zone,
    });
    assert.equal(rejected.decisions.length, 2);
    assert.equal(f.knowledge.find(previous.id, scope)?.status, "rejected");
    assert.equal(f.knowledge.find(foreign.id, scope)?.status, "rejected");
    assert.throws(
      () =>
        f.knowledge.decideProposals({
          action: "approved",
          ids: ["missing-proposal"],
          areas,
          timeZone: zone,
        }),
      UnknownProposal,
    );
    assert.equal(supersedes(f.path), 0);
    assert.equal(earlier.id < weekOf.id, true);
  } finally {
    await f.close();
  }
});

test("an older project catalog gains review columns without dropping rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-review-migrate-"));
  const path = join(directory, "context.db");
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE project_associations (
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (record_kind, record_id, project_id, origin)
      );
      INSERT INTO project_associations
        VALUES ('source', 'src-1', 'observatory', 'proposed', 'proposed');
      CREATE TABLE project_proposals (
        id TEXT PRIMARY KEY NOT NULL,
        record_kind TEXT NOT NULL,
        record_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        suggested_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO project_proposals
        VALUES ('proposal:old', 'knowledge', 'item-1', 'src-1', 'Fictional Annex', '2026-11-01T00:00:00.000Z');
    `);
    db.close();
    const sources = new SourceStore(path);
    sources.close();
    const check = new DatabaseSync(path, { readOnly: true });
    const association = String(
      check
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'project_associations'",
        )
        .get()?.sql,
    );
    const status = check
      .prepare(
        `SELECT status FROM project_associations
         WHERE record_id = 'src-1' AND project_id = 'observatory'`,
      )
      .get() as { status: string };
    const proposal = check
      .prepare("SELECT status FROM project_proposals WHERE id = 'proposal:old'")
      .get() as { status: string };
    check.close();
    assert.equal(association.includes("'rejected'"), true);
    assert.equal(status.status, "proposed");
    assert.equal(proposal.status, "proposed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the owner CLI approves a pinned decision and leaves the other week proposed", async () => {
  const f = await open("review-cli");
  const env = {
    ...process.env,
    CONTEXT_DB_PATH: f.path,
    CONTEXT_AREAS: scope,
    TZ: "UTC",
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
    });
  try {
    const source = capture(
      f.sources,
      "cli-motors",
      "Source for the CLI shutter rule.",
      "2026-11-11T00:00:00.000Z",
      "observatory",
    );
    const pinned = distill(
      f.knowledge,
      source.id,
      "decision",
      "Dome motors stay disabled until the shutter is confirmed closed.",
      "2026-11-11T00:00:00.000Z",
    );
    const older = distill(
      f.knowledge,
      capture(
        f.sources,
        "cli-older",
        "Source for the older lantern rule.",
        "2026-11-04T00:00:00.000Z",
        "observatory",
      ).id,
      "decision",
      "The observatory project kept the lantern rule.",
      "2026-11-04T00:00:00.000Z",
    );
    f.sources.setProfile({
      projectId: "observatory",
      purpose: "Track the fictional observatory dome.",
      rules: "Do not move the dome while the shutter is open.",
      pinned: [pinned.id],
    });
    const listed = run([
      "project",
      "review",
      "list",
      "--project",
      "observatory",
      "--kind",
      "decision",
      "--week",
      weekOf.id,
    ]);
    assert.equal(listed.status, 0, listed.stderr);
    const proposals = JSON.parse(listed.stdout) as {
      proposals: { id: string }[];
    };
    assert.deepEqual(
      proposals.proposals.map((row) => row.id),
      [pinned.id],
    );
    const approved = run([
      "project",
      "review",
      "approve",
      "--project",
      "observatory",
      "--week",
      weekOf.id,
    ]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(JSON.parse(approved.stdout).decisions[0].id, pinned.id);
    const usage = run(["project", "review", "approve"]);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /review approve/);
    assert.deepEqual(f.sources.profile("observatory")?.inForce, [
      {
        id: pinned.id,
        text: "Dome motors stay disabled until the shutter is confirmed closed.",
      },
    ]);
    assert.equal(f.knowledge.find(older.id, scope)?.status, "proposed");
    assert.equal(supersedes(f.path), 0);
  } finally {
    await f.close();
  }
});

test("legacy non-JSON review evidence still sets item status", async () => {
  const f = await open("review-legacy-evidence");
  try {
    const source = capture(
      f.sources,
      "legacy-evidence",
      "Source for a historical review row.",
      "2026-11-11T00:00:00.000Z",
      "observatory",
    );
    const item = distill(
      f.knowledge,
      source.id,
      "fact",
      "The observatory project kept a historical status row.",
      "2026-11-11T00:00:00.000Z",
    );
    const db = new DatabaseSync(f.path);
    db.prepare(
      `INSERT INTO knowledge_reviews
        (id, knowledge_id, scope, status, evidence, reviewer, signed_receipt, created_at)
       VALUES (?, ?, ?, 'rejected', 'Fictional historical status', 'fixture', '{}', ?)`,
    ).run("legacy-evidence-review", item.id, scope, "2026-11-11T01:00:00.000Z");
    db.close();
    assert.equal(f.knowledge.find(item.id, scope)?.status, "rejected");
  } finally {
    await f.close();
  }
});

test("project review rejects a mixed id and week command", () => {
  assert.throws(
    () =>
      projectCommand(
        ["review", "approve", "--id", "one", "--project", "observatory"],
        { ...process.env, CONTEXT_DB_PATH: "unused.db", CONTEXT_AREAS: scope },
      ),
    /review approve/,
  );
});
