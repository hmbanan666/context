import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, type ReviewKnowledgeInput } from "../src/knowledge.js";
import { applyOwnerReview, ownerReviewPayload } from "../src/owner-review.js";
import { SourceStore } from "../src/store.js";

test("only a receipt signed by the configured owner key can approve a grounded decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-owner-review-"));
  const database = join(directory, "context.db");
  const sources = new SourceStore(database);
  const knowledge = new KnowledgeStore(database);
  const owner = generateKeyPairSync("ed25519");
  const foreign = generateKeyPairSync("ed25519");
  const publicKey = owner.publicKey.export({ type: "spki", format: "pem" });
  try {
    const { source } = sources.capture({
      version: 1,
      scope: "synthetic:owner-review",
      text: "Synthetic decision: build a paper observatory.",
      origin: "fixture:owner-review",
      idempotencyKey: "source",
    });
    const { item } = knowledge.add({
      version: 1,
      scope: source.scope,
      kind: "decision_proposal",
      text: "Build a paper observatory",
      sourceRefs: [{ sourceId: source.id }],
      creator: { kind: "model", name: "fixture" },
      idempotencyKey: "proposal",
    });
    const review: ReviewKnowledgeInput = {
      version: 1,
      scope: source.scope,
      id: item.id,
      idempotencyKey: "approval",
      status: "approved",
      evidence: "Owner's synthetic signed approval",
    };
    const receipt = {
      review,
      signature: sign(
        null,
        ownerReviewPayload(review),
        owner.privateKey,
      ).toString("base64"),
    };
    const forged = {
      review,
      signature: sign(
        null,
        ownerReviewPayload(review),
        foreign.privateKey,
      ).toString("base64"),
    };
    assert.throws(() => applyOwnerReview(knowledge, forged, publicKey));
    assert.throws(() =>
      applyOwnerReview(
        knowledge,
        { ...receipt, review: { ...review, evidence: "Tampered evidence" } },
        publicKey,
      ),
    );
    assert.throws(() =>
      applyOwnerReview(
        knowledge,
        { ...receipt, review: { ...review, scope: "synthetic:other" } },
        publicKey,
      ),
    );
    assert.equal(knowledge.find(item.id, source.scope)?.status, "suggested");
    const approved = applyOwnerReview(knowledge, receipt, publicKey);
    assert.equal(approved.item.status, "approved");
    assert.deepEqual(approved.event.signedReceipt, receipt);
    assert.equal(
      applyOwnerReview(knowledge, receipt, publicKey).duplicate,
      true,
    );
    assert.equal(knowledge.history(item.id, source.scope).length, 1);
  } finally {
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
