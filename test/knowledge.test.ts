import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import {
  type AddKnowledgeInput,
  addKnowledgeSchema,
  KnowledgeNotFound,
  KnowledgeStore,
  KnowledgeValidationError,
  type RelateKnowledgeInput,
  type ReviewKnowledgeInput,
  type VerifiedKnowledgeOwner,
} from "../src/knowledge.js";
import { IdempotencyConflict, SourceStore } from "../src/store.js";

const scope = "synthetic:knowledge";
const owner: VerifiedKnowledgeOwner = {
  kind: "verified-owner-signature",
  subject: "synthetic-owner",
  authenticated: true,
  signature: `${"A".repeat(86)}==`,
};
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
    scope: "synthetic:other-project",
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
      assert.equal(
        reopened.find(saved.item.id, "synthetic:other-project"),
        undefined,
      );
      assert.deepEqual(reopened.list("synthetic:other-project"), []);
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
      { ...f.input, scope: "private:project" },
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

test("owner review is independent of model claims and appends decision history", async () => {
  const f = await fixture();
  try {
    const idea = f.knowledge.add(f.input).item;
    const proposal = f.knowledge.add({
      ...f.input,
      idempotencyKey: "decision-1",
      kind: "decision_proposal",
    }).item;
    const review: ReviewKnowledgeInput = {
      version: 1,
      scope,
      id: proposal.id,
      idempotencyKey: "review-1",
      status: "approved",
      evidence:
        "Synthetic owner confirmed this proposal in the signed owner review receipt.",
    };
    for (const unverified of [
      null,
      { kind: "model", subject: "synthetic-owner", authenticated: true },
      { ...owner, authenticated: false },
    ]) {
      assert.throws(() =>
        f.knowledge.review(review, JSON.parse(JSON.stringify(unverified))),
      );
    }
    assert.equal(f.knowledge.find(proposal.id, scope)?.status, "suggested");
    assert.deepEqual(f.knowledge.history(proposal.id, scope), []);
    assert.throws(
      () => f.knowledge.review({ ...review, id: idea.id }, owner),
      KnowledgeValidationError,
    );
    assert.throws(
      () => f.knowledge.review({ ...review, scope: f.foreign.scope }, owner),
      KnowledgeNotFound,
    );
    const approved = f.knowledge.review(review, owner);
    assert.equal(approved.item.status, "approved");
    assert.equal(approved.event.reviewer, owner.subject);
    assert.deepEqual(f.knowledge.review(review, owner), {
      ...approved,
      duplicate: true,
    });
    const rejected = f.knowledge.review(
      {
        ...review,
        idempotencyKey: "review-2",
        status: "rejected",
        evidence: "Synthetic owner withdrew the decision.",
      },
      owner,
    );
    assert.equal(rejected.item.status, "rejected");
    assert.deepEqual(f.knowledge.history(proposal.id, scope), [
      approved.event,
      rejected.event,
    ]);
    assert.deepEqual(f.knowledge.history(proposal.id, f.foreign.scope), []);
    assert.deepEqual(f.knowledge.find(idea.id, scope), idea);
    assert.deepEqual(f.sources.find(f.source.id, scope), f.source);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("online backup and offline restore preserve knowledge, review history, relations and retries together", async () => {
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
    const reviewInput: ReviewKnowledgeInput = {
      version: 1,
      scope,
      id: proposal.id,
      idempotencyKey: "review-1",
      status: "approved",
      evidence: "Synthetic owner approval.",
    };
    const approved = f.knowledge.review(reviewInput, owner);
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
      assert.deepEqual(
        restoredKnowledge.find(proposal.id, scope),
        approved.item,
      );
      assert.deepEqual(restoredKnowledge.history(proposal.id, scope), [
        approved.event,
      ]);
      assert.deepEqual(restoredKnowledge.add(proposalInput), {
        item: approved.item,
        duplicate: true,
      });
      assert.deepEqual(restoredKnowledge.relate(relationInput), {
        ...linked,
        duplicate: true,
      });
      assert.deepEqual(restoredKnowledge.review(reviewInput, owner), {
        ...approved,
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
