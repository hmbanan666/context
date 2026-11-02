import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import {
  type AddKnowledgeInput,
  addKnowledgeSchema,
  KnowledgeNotFound,
  KnowledgeStore,
  KnowledgeValidationError,
  type RelateKnowledgeInput,
} from "../src/knowledge.js";
import { IdempotencyConflict, SourceStore } from "../src/store.js";

const scope = "knowledge";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "context-knowledge-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const source = sources.capture({
    version: 1,
    scope,
    text: "Synthetic lunar garden: test the violet lamp before planting.",
    origin: "fixture:knowledge",
    idempotencyKey: "source-1",
  }).source;
  const foreign = sources.capture({
    version: 1,
    scope: "other-project",
    text: "Synthetic other-project source",
    origin: "fixture:knowledge",
    idempotencyKey: "source-1",
  }).source;
  const knowledge = new KnowledgeStore(path);
  const input: AddKnowledgeInput = {
    version: 1,
    scope,
    idempotencyKey: "idea-1",
    kind: "idea",
    text: "Try the violet lamp for the synthetic garden.",
    sourceRefs: [{ sourceId: source.id, quote: "test the violet lamp" }],
    creator: {
      kind: "model",
      name: "synthetic-extractor",
      version: "fixture-1",
    },
  };
  return { directory, path, sources, source, foreign, knowledge, input };
}

test("grounded knowledge preserves creation, conservative status and persistent retry keys across restart", async () => {
  const f = await fixture();
  try {
    const saved = f.knowledge.add(f.input);
    assert.equal(saved.duplicate, false);
    assert.equal(saved.item.status, "suggested");
    assert.deepEqual(saved.item.sourceRefs, [
      { sourceId: f.source.id, quote: "test the violet lamp" },
    ]);
    assert.deepEqual(f.sources.find(f.source.id, scope), f.source);
    f.knowledge.close();
    const reopened = new KnowledgeStore(f.path);
    try {
      assert.deepEqual(reopened.find(saved.item.id, scope), saved.item);
      assert.deepEqual(reopened.add(f.input), {
        item: saved.item,
        duplicate: true,
      });
      assert.deepEqual(reopened.list(scope), [saved.item]);
      assert.throws(
        () => reopened.add({ ...f.input, text: "A different idea" }),
        IdempotencyConflict,
      );
      assert.equal(reopened.find(saved.item.id, "other-project"), undefined);
      assert.deepEqual(reopened.list("other-project"), []);
    } finally {
      reopened.close();
    }
  } finally {
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("invalid provenance and approval claims cannot consume a retry key or create knowledge", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        f.knowledge.add({
          ...f.input,
          sourceRefs: [{ sourceId: f.foreign.id }],
        }),
      KnowledgeNotFound,
    );
    assert.throws(
      () =>
        f.knowledge.add({ ...f.input, sourceRefs: [{ sourceId: "absent" }] }),
      KnowledgeNotFound,
    );
    assert.throws(
      () =>
        f.knowledge.add({
          ...f.input,
          sourceRefs: [{ sourceId: f.source.id, quote: "not in the source" }],
        }),
      KnowledgeValidationError,
    );
    for (const invalid of [
      { ...f.input, status: "approved" },
      { ...f.input, sourceRefs: [] },
      {
        ...f.input,
        sourceRefs: [{ sourceId: f.source.id }, { sourceId: f.source.id }],
      },
      { ...f.input, creator: { ...f.input.creator, approved: true } },
      { ...f.input, text: "bad\ud800" },
      { ...f.input, scope: "invalid area" },
    ]) {
      assert.equal(addKnowledgeSchema.safeParse(invalid).success, false);
    }
    assert.deepEqual(f.knowledge.list(scope), []);
    assert.equal(f.knowledge.add(f.input).duplicate, false);
    assert.deepEqual(f.sources.find(f.source.id, scope), f.source);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("relations retain provenance and supersession history without granting approval or crossing scopes", async () => {
  const f = await fixture();
  try {
    const original = f.knowledge.add(f.input).item;
    const replacement = f.knowledge.add({
      ...f.input,
      idempotencyKey: "idea-2",
      text: "Try a revised violet lamp.",
    }).item;
    const foreign = f.knowledge.add({
      ...f.input,
      scope: f.foreign.scope,
      sourceRefs: [{ sourceId: f.foreign.id }],
    }).item;
    const relation: RelateKnowledgeInput = {
      version: 1,
      scope,
      idempotencyKey: "relation-1",
      kind: "supersedes",
      fromId: replacement.id,
      toId: original.id,
      sourceRefs: [{ sourceId: f.source.id }],
      creator: f.input.creator,
    };
    assert.throws(
      () => f.knowledge.relate({ ...relation, toId: foreign.id }),
      KnowledgeNotFound,
    );
    assert.throws(
      () =>
        f.knowledge.relate({
          ...relation,
          sourceRefs: [{ sourceId: f.foreign.id }],
        }),
      KnowledgeNotFound,
    );
    const saved = f.knowledge.relate(relation);
    assert.equal(saved.relation.status, "suggested");
    assert.deepEqual(f.knowledge.relate(relation), {
      relation: saved.relation,
      duplicate: true,
    });
    assert.deepEqual(f.knowledge.relations(scope), [saved.relation]);
    assert.deepEqual(f.knowledge.relations(f.foreign.scope), []);
    assert.deepEqual(f.knowledge.find(original.id, scope), original);
    assert.deepEqual(f.knowledge.find(replacement.id, scope), replacement);
    assert.throws(
      () => f.knowledge.relate({ ...relation, kind: "contradicts" }),
      IdempotencyConflict,
    );
    assert.throws(() =>
      f.knowledge.relate({ ...relation, fromId: original.id }),
    );
    assert.throws(
      () =>
        f.knowledge.add({
          ...f.input,
          idempotencyKey: relation.idempotencyKey,
        }),
      IdempotencyConflict,
    );
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("online backup and offline restore preserve knowledge, relations and retries together", async () => {
  const f = await fixture();
  try {
    const proposalInput: AddKnowledgeInput = {
      ...f.input,
      kind: "decision_proposal",
    };
    const proposal = f.knowledge.add(proposalInput).item;
    const observation = f.knowledge.add({
      ...f.input,
      idempotencyKey: "observation-1",
      kind: "observation",
    }).item;
    const relationInput: RelateKnowledgeInput = {
      version: 1,
      scope,
      idempotencyKey: "relation-1",
      kind: "supports",
      fromId: observation.id,
      toId: proposal.id,
      sourceRefs: f.input.sourceRefs,
      creator: f.input.creator,
    };
    const linked = f.knowledge.relate(relationInput);
    const backup = join(f.directory, "snapshot.db");
    const restored = join(f.directory, "restored.db");
    await backupDatabase(f.path, backup);
    await restoreDatabase(backup, restored);
    const restoredSources = new SourceStore(restored);
    const restoredKnowledge = new KnowledgeStore(restored);
    try {
      assert.deepEqual(restoredSources.find(f.source.id, scope), f.source);
      assert.deepEqual(restoredKnowledge.find(proposal.id, scope), proposal);
      assert.deepEqual(restoredKnowledge.add(proposalInput), {
        item: proposal,
        duplicate: true,
      });
      assert.deepEqual(restoredKnowledge.relate(relationInput), {
        ...linked,
        duplicate: true,
      });
    } finally {
      restoredKnowledge.close();
      restoredSources.close();
    }
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("relations accept source endpoints and duplicates while retaining same-area validation", async () => {
  const f = await fixture();
  try {
    const item = f.knowledge.add(f.input).item;
    const input: RelateKnowledgeInput = {
      version: 1,
      scope,
      idempotencyKey: "source-relation",
      kind: "duplicates",
      fromId: f.source.id,
      toId: item.id,
      sourceRefs: [{ sourceId: f.source.id }],
      creator: f.input.creator,
    };
    const saved = f.knowledge.relate(input);
    assert.equal(saved.relation.fromId, f.source.id);
    assert.equal(f.knowledge.relate(input).duplicate, true);
    assert.throws(
      () =>
        f.knowledge.relate({
          ...input,
          idempotencyKey: "foreign",
          toId: f.foreign.id,
        }),
      KnowledgeNotFound,
    );
    assert.deepEqual(f.sources.find(f.source.id, scope), f.source);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("old relation CHECK migration preserves all three kinds and their retry identities", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture();
  const a = f.knowledge.add(f.input).item;
  const b = f.knowledge.add({ ...f.input, idempotencyKey: "second" }).item;
  const inputs = (["supports", "contradicts", "supersedes"] as const).map(
    (kind) => ({
      version: 1 as const,
      scope,
      idempotencyKey: kind,
      kind,
      fromId: a.id,
      toId: b.id,
      sourceRefs: f.input.sourceRefs,
      creator: f.input.creator,
    }),
  );
  const before = inputs.map((input) => f.knowledge.relate(input).relation);
  f.knowledge.close();
  const db = new DatabaseSync(f.path);
  try {
    db.exec(`ALTER TABLE knowledge_relations RENAME TO fixture_relations;
      CREATE TABLE knowledge_relations (
        id TEXT PRIMARY KEY NOT NULL,scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('supports','contradicts','supersedes')),
        from_id TEXT NOT NULL REFERENCES knowledge_items(id),to_id TEXT NOT NULL REFERENCES knowledge_items(id),
        source_refs TEXT NOT NULL,creator TEXT NOT NULL,created_at TEXT NOT NULL,CHECK(from_id <> to_id)
      ) STRICT;
      INSERT INTO knowledge_relations SELECT * FROM fixture_relations;
      DROP TABLE fixture_relations;`);
    f.knowledge = new KnowledgeStore(f.path);
    for (const [index, input] of inputs.entries())
      assert.deepEqual(f.knowledge.relate(input), {
        relation: before[index],
        duplicate: true,
      });
    assert.equal(f.knowledge.relations(scope).length, 3);
    assert.equal(
      f.knowledge.relate({
        ...inputs[0],
        version: 1,
        scope,
        sourceRefs: f.input.sourceRefs,
        creator: f.input.creator,
        idempotencyKey: "new-source-link",
        kind: "duplicates",
        fromId: f.source.id,
        toId: a.id,
      }).duplicate,
      false,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
