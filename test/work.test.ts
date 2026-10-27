import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { syntheticGitHubFetch } from "../fixtures/synthetic-github.js";
import { workFixture } from "../fixtures/synthetic-work.js";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import { KnowledgeStore, type ReviewKnowledgeInput } from "../src/knowledge.js";
import { applyOwnerReview, ownerReviewPayload } from "../src/owner-review.js";
import { SourceStore } from "../src/store.js";
import { applyWorkAuthorization, WorkStore } from "../src/work.js";

test("work requires separate signed dispatch/disclosure bound to current approved intent and exact sources", async () => {
  const f = await workFixture();
  try {
    const receipt = f.receipt();
    const foreign = generateKeyPairSync("ed25519");
    assert.throws(() =>
      applyWorkAuthorization(
        f.work,
        receipt,
        foreign.publicKey.export({ type: "spki", format: "pem" }),
      ),
    );
    assert.throws(() =>
      applyWorkAuthorization(
        f.work,
        {
          ...receipt,
          authorization: { ...f.authorization, repository: "other/repo" },
        },
        f.publicKey,
      ),
    );
    assert.throws(() =>
      applyWorkAuthorization(
        f.work,
        f.receipt({ ...f.authorization, scope: "synthetic:foreign" }),
        f.publicKey,
      ),
    );
    assert.throws(() =>
      applyWorkAuthorization(
        f.work,
        f.receipt({
          ...f.authorization,
          disclose: { intent: true, sourceIds: ["foreign-source"] },
        }),
        f.publicKey,
      ),
    );
    const saved = applyWorkAuthorization(f.work, receipt, f.publicKey);
    assert.equal(saved.duplicate, false);
    assert.equal(
      applyWorkAuthorization(f.work, receipt, f.publicKey).duplicate,
      true,
    );
    assert.throws(() =>
      applyWorkAuthorization(
        f.work,
        f.receipt({ ...f.authorization, branch: "different" }),
        f.publicKey,
      ),
    );
    const context = f.work.context(saved.work.id, f.source.scope);
    assert.equal(context.result, "unverified");
    assert.equal(context.deployment, "unverified");
    assert.deepEqual(
      context.sources.map((entry) => entry.source),
      [f.source],
    );
    assert.equal(context.approval.id, f.authorization.approvalId);
    assert.equal(f.work.find(saved.work.id, "synthetic:foreign"), undefined);
    assert.throws(() => f.work.context(saved.work.id, f.source.scope, 1024));
    assert.deepEqual(f.sources.find(f.source.id, f.source.scope), f.source);
  } finally {
    await f.close();
  }
});

test("GitHub open/failed/unmerged facts never complete work; merged passing evidence stays separate from deployment and survives restore", async () => {
  const f = await workFixture();
  try {
    const saved = applyWorkAuthorization(f.work, f.receipt(), f.publicKey).work;
    const target = { ...f.authorization, pullNumber: 7 };
    const sync = (
      key: string,
      options: Parameters<typeof syntheticGitHubFetch>[1],
    ) =>
      f.work.refresh(
        saved.id,
        saved.scope,
        7,
        key,
        syntheticGitHubFetch(target, options),
      );
    const open = await sync("open", { checkState: "passed" });
    assert.equal(open.observation.evidence?.checks.state, "passed");
    assert.equal(f.work.context(saved.id, saved.scope).result, "unverified");
    await sync("closed", { state: "closed" });
    assert.equal(f.work.context(saved.id, saved.scope).result, "unverified");
    await sync("failed", { merged: true, checkState: "failed" });
    assert.equal(f.work.context(saved.id, saved.scope).result, "unverified");
    await sync("pending", { merged: true, checkState: "pending" });
    assert.equal(f.work.context(saved.id, saved.scope).result, "unverified");
    await sync("unknown", { merged: true, checkState: "unknown" });
    assert.equal(f.work.context(saved.id, saved.scope).result, "unverified");
    const merged = await sync("merged", { merged: true });
    assert.equal(
      f.work.context(saved.id, saved.scope).result,
      "merged_ci_passed",
    );
    assert.equal(
      f.work.context(saved.id, saved.scope).deployment,
      "unverified",
    );
    const neverFetch: typeof fetch = async () => {
      throw new Error("Must not fetch on repeat or denial");
    };
    assert.deepEqual(
      await f.work.refresh(saved.id, saved.scope, 7, "merged", neverFetch),
      { observation: merged.observation, duplicate: true },
    );
    await assert.rejects(() =>
      f.work.refresh(saved.id, saved.scope, 8, "merged", neverFetch),
    );
    await assert.rejects(() =>
      f.work.refresh(saved.id, saved.scope, 8, "rebind", neverFetch),
    );
    await assert.rejects(() =>
      f.work.refresh(saved.id, "synthetic:foreign", 7, "foreign", neverFetch),
    );
    const failed = await f.work.refresh(
      saved.id,
      saved.scope,
      7,
      "network-failed",
      neverFetch,
    );
    assert.equal(failed.observation.error, "github_unavailable");
    const stale = f.work.context(saved.id, saved.scope);
    assert.equal(stale.result, "unverified");
    assert.equal(stale.latest?.evidence, null);
    assert.ok(
      stale.history.some((event) => event.id === merged.observation.id),
    );
    const minimumBytes =
      Buffer.byteLength(
        JSON.stringify({ ...stale, history: [], historyTruncated: true }),
        "utf8",
      ) + 10;
    const bounded = f.work.context(saved.id, saved.scope, minimumBytes);
    assert.equal(bounded.historyTruncated, true);
    assert.equal(bounded.history.length, 0);
    assert.deepEqual(bounded.sources, stale.sources);
    assert.deepEqual(bounded.latest, stale.latest);
    assert.ok(
      Buffer.byteLength(JSON.stringify(bounded), "utf8") <= minimumBytes,
    );
    assert.deepEqual(f.sources.find(f.source.id, f.source.scope), f.source);
    const snapshot = join(f.directory, "snapshot.db"),
      restored = join(f.directory, "restored.db");
    await backupDatabase(f.path, snapshot);
    await restoreDatabase(snapshot, restored);
    const sources = new SourceStore(restored),
      knowledge = new KnowledgeStore(restored),
      work = new WorkStore(restored, sources, knowledge);
    try {
      assert.deepEqual(work.context(saved.id, saved.scope), stale);
      assert.equal(
        applyWorkAuthorization(work, f.receipt(), f.publicKey).duplicate,
        true,
      );
      assert.deepEqual(
        await work.refresh(saved.id, saved.scope, 7, "merged", neverFetch),
        { observation: merged.observation, duplicate: true },
      );
      assert.deepEqual(sources.find(f.source.id, f.source.scope), f.source);
    } finally {
      work.close();
      knowledge.close();
      sources.close();
    }
  } finally {
    await f.close();
  }
});

test("an old merged PR is historical evidence, not completion of a newly authorized intent", async () => {
  const f = await workFixture();
  try {
    const work = applyWorkAuthorization(f.work, f.receipt(), f.publicKey).work;
    await f.work.refresh(
      work.id,
      work.scope,
      7,
      "old",
      syntheticGitHubFetch(
        { ...f.authorization, pullNumber: 7 },
        { merged: true, createdAt: "2020-01-01T00:00:00Z" },
      ),
    );
    const context = f.work.context(work.id, work.scope);
    assert.ok(context.latest?.evidence?.merge);
    assert.equal(context.latest.evidence.checks.state, "passed");
    assert.equal(context.result, "unverified");
    assert.equal(context.resultReason, "pr_predates_authorization");
  } finally {
    await f.close();
  }
});

test("repeated large GitHub observations keep the latest complete planner package readable", async () => {
  const f = await workFixture();
  try {
    const authorization = {
      ...f.authorization,
      requiredChecks: Array.from(
        { length: 20 },
        (_, index) => `synthetic-required-check-${index}-${"x".repeat(70)}`,
      ),
    };
    const work = applyWorkAuthorization(
      f.work,
      f.receipt(authorization),
      f.publicKey,
    ).work;
    for (let index = 0; index < 16; index++) {
      await f.work.refresh(
        work.id,
        work.scope,
        7,
        `observation-${index}`,
        syntheticGitHubFetch(
          { ...authorization, pullNumber: 7 },
          { merged: true },
        ),
      );
    }
    const context = f.work.context(work.id, work.scope);
    assert.equal(context.result, "merged_ci_passed");
    assert.equal(context.historyTruncated, true);
    assert.ok(context.history.length < 15);
    assert.equal(context.latest?.evidence?.checks.runs.length, 20);
    assert.deepEqual(
      context.sources.map((entry) => entry.source),
      [f.source],
    );
    assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 65536);
  } finally {
    await f.close();
  }
});

test("revoking or replacing intent approval disables existing authorization before network access", async () => {
  const f = await workFixture();
  try {
    const saved = applyWorkAuthorization(f.work, f.receipt(), f.publicKey).work;
    const review: ReviewKnowledgeInput = {
      version: 1,
      scope: saved.scope,
      id: f.intent.id,
      idempotencyKey: "reject",
      status: "rejected",
      evidence: "Synthetic owner revocation",
    };
    applyOwnerReview(
      f.knowledge,
      {
        review,
        signature: sign(
          null,
          ownerReviewPayload(review),
          f.key.privateKey,
        ).toString("base64"),
      },
      f.publicKey,
    );
    assert.equal(
      f.work.context(saved.id, saved.scope).authorizationActive,
      false,
    );
    assert.throws(() =>
      applyWorkAuthorization(f.work, f.receipt(), f.publicKey),
    );
    let calls = 0;
    await assert.rejects(() =>
      f.work.refresh(saved.id, saved.scope, 7, "revoked", async () => {
        calls++;
        throw new Error("No request permitted");
      }),
    );
    assert.equal(calls, 0);
    const reapproval = {
      ...review,
      idempotencyKey: "reapprove",
      status: "approved" as const,
    };
    applyOwnerReview(
      f.knowledge,
      {
        review: reapproval,
        signature: sign(
          null,
          ownerReviewPayload(reapproval),
          f.key.privateKey,
        ).toString("base64"),
      },
      f.publicKey,
    );
    assert.equal(
      f.work.context(saved.id, saved.scope).authorizationActive,
      false,
    );
  } finally {
    await f.close();
  }
});
