import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, type ReviewKnowledgeInput } from "../src/knowledge.js";
import { applyOwnerReview, ownerReviewPayload } from "../src/owner-review.js";
import { SourceStore } from "../src/store.js";
import {
  type WorkAuthorization,
  WorkStore,
  workAuthorizationPayload,
} from "../src/work.js";

export async function workFixture() {
  const directory = await mkdtemp(join(tmpdir(), "context-work-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const work = new WorkStore(path, sources, knowledge);
  // Ephemeral synthetic keys are never human production approval.
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" });
  const source = sources.capture({
    version: 1,
    scope: "synthetic:work",
    text: "Synthetic thought: a paper observatory needs a tested wind dial.",
    origin: "fixture:work",
    idempotencyKey: "source",
  }).source;
  const intent = knowledge.add({
    version: 1,
    scope: source.scope,
    kind: "decision_proposal",
    text: "Test the synthetic wind dial",
    sourceRefs: [{ sourceId: source.id, quote: "tested wind dial" }],
    creator: { kind: "model", name: "synthetic-planner" },
    idempotencyKey: "intent",
  }).item;
  const review: ReviewKnowledgeInput = {
    version: 1,
    scope: source.scope,
    id: intent.id,
    idempotencyKey: "approve",
    status: "approved",
    evidence: "Synthetic owner approval, not production authorization",
  };
  const approve = () =>
    applyOwnerReview(
      knowledge,
      {
        review,
        signature: sign(
          null,
          ownerReviewPayload(review),
          key.privateKey,
        ).toString("base64"),
      },
      publicKey,
    );
  const approved = approve();
  const authorization: WorkAuthorization = {
    version: 1,
    scope: source.scope,
    idempotencyKey: "dispatch",
    intentId: intent.id,
    approvalId: approved.event.id,
    repository: "synthetic/observatory",
    branch: "feat/wind-dial",
    baseBranch: "main",
    requiredChecks: ["check"],
    dispatch: true,
    disclose: { intent: true, sourceIds: [source.id] },
  };
  const receipt = (input = authorization) => ({
    authorization: input,
    signature: sign(
      null,
      workAuthorizationPayload(input),
      key.privateKey,
    ).toString("base64"),
  });
  return {
    directory,
    path,
    sources,
    knowledge,
    work,
    publicKey,
    key,
    source,
    intent,
    authorization,
    receipt,
    async close() {
      work.close();
      knowledge.close();
      sources.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
