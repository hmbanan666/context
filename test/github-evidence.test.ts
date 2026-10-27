import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchGitHubEvidence,
  githubEvidenceSchema,
  githubTargetSchema,
} from "../src/github-evidence.js";

const head = "a".repeat(40);
const merge = "b".repeat(40);
const target = {
  repository: "synthetic-owner/paper-observatory",
  branch: "feat/paper-map",
  baseBranch: "main",
  pullNumber: 7,
  requiredChecks: ["verify"],
};
const pull = {
  number: 7,
  html_url: "https://github.com/synthetic-owner/paper-observatory/pull/7",
  state: "open",
  draft: false,
  merged: false,
  created_at: "2026-10-27T10:00:00Z",
  merged_at: null as string | null,
  merge_commit_sha: null as string | null,
  head: {
    sha: head,
    ref: target.branch,
    repo: { full_name: target.repository, private: false },
  },
  base: { ref: "main", repo: { full_name: target.repository, private: false } },
};
const check = {
  name: "verify",
  status: "completed",
  conclusion: "success" as string | null,
  html_url:
    "https://github.com/synthetic-owner/paper-observatory/actions/runs/42",
  head_sha: head,
};
const checks = { total_count: 1, check_runs: [check] };
const statuses = {
  sha: head,
  total_count: 0,
  statuses: [] as {
    context: string;
    state: string;
    target_url: string | null;
  }[],
};

function fixture(
  overrides: {
    firstPull?: unknown;
    lastPull?: unknown;
    runs?: unknown;
    combined?: unknown;
    respond?: (url: string) => Response | undefined;
  } = {},
) {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  let pullCalls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    const address = String(url);
    requests.push({ url: address, options });
    const response = overrides.respond?.(address);
    if (response) return response;
    if (address.endsWith("/pulls/7")) {
      pullCalls++;
      return Response.json(
        pullCalls === 1
          ? (overrides.firstPull ?? pull)
          : (overrides.lastPull ?? overrides.firstPull ?? pull),
      );
    }
    if (address.includes("/check-runs?"))
      return Response.json(overrides.runs ?? checks);
    if (address.includes("/status?"))
      return Response.json(overrides.combined ?? statuses);
    throw new Error("Unexpected request");
  };
  return { fetcher, requests };
}

test("independent public GitHub reads preserve an open green PR without claiming merge or deployment", async () => {
  const { fetcher, requests } = fixture();
  const evidence = await fetchGitHubEvidence(target, fetcher);
  assert.equal(evidence.state, "open");
  assert.equal(evidence.checks.state, "passed");
  assert.equal(evidence.merge, null);
  assert.equal(evidence.deployment, "unverified");
  assert.equal(evidence.headSha, head);
  assert.deepEqual(evidence.checks.required, ["verify"]);
  assert.equal(evidence.checks.runs[0]?.headSha, head);
  assert.equal(githubEvidenceSchema.safeParse(evidence).success, true);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.github.com/repos/synthetic-owner/paper-observatory/pulls/7",
      `https://api.github.com/repos/synthetic-owner/paper-observatory/commits/${head}/check-runs?filter=latest&per_page=100`,
      `https://api.github.com/repos/synthetic-owner/paper-observatory/commits/${head}/status?per_page=100`,
      "https://api.github.com/repos/synthetic-owner/paper-observatory/pulls/7",
    ],
  );
  for (const { options } of requests) {
    assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.body, undefined);
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
  }
});

test("merge evidence stays distinct from CI and deployment, and closed unmerged stays unmerged", async () => {
  const closed = { ...pull, state: "closed" };
  assert.equal(
    (await fetchGitHubEvidence(target, fixture({ firstPull: closed }).fetcher))
      .merge,
    null,
  );
  const merged = {
    ...closed,
    merged: true,
    merged_at: "2026-10-27T12:00:00Z",
    merge_commit_sha: merge,
  };
  const evidence = await fetchGitHubEvidence(
    target,
    fixture({ firstPull: merged }).fetcher,
  );
  assert.deepEqual(evidence.merge, {
    sha: merge,
    mergedAt: "2026-10-27T12:00:00Z",
  });
  assert.equal(evidence.deployment, "unverified");
});

test("required checks need successful current evidence; neutral, skipped and missing are unknown", async () => {
  for (const conclusion of ["neutral", "skipped", null]) {
    const evidence = await fetchGitHubEvidence(
      target,
      fixture({
        runs: { total_count: 1, check_runs: [{ ...check, conclusion }] },
      }).fetcher,
    );
    assert.equal(evidence.checks.state, "unknown");
  }
  const absent = await fetchGitHubEvidence(
    target,
    fixture({ runs: { total_count: 0, check_runs: [] } }).fetcher,
  );
  assert.equal(absent.checks.state, "unknown");
  const statusOnly = await fetchGitHubEvidence(
    target,
    fixture({
      runs: { total_count: 0, check_runs: [] },
      combined: {
        ...statuses,
        total_count: 1,
        statuses: [{ context: "verify", state: "success", target_url: null }],
      },
    }).fetcher,
  );
  assert.equal(statusOnly.checks.state, "passed");
});

test("failure and pending evidence cannot be hidden by a successful check with the same name", async () => {
  for (const state of ["failure", "error", "pending"]) {
    const evidence = await fetchGitHubEvidence(
      target,
      fixture({
        combined: {
          ...statuses,
          total_count: 1,
          statuses: [{ context: "verify", state, target_url: null }],
        },
      }).fetcher,
    );
    assert.equal(
      evidence.checks.state,
      state === "pending" ? "pending" : "failed",
    );
  }
  for (const conclusion of [
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
    "stale",
  ]) {
    const evidence = await fetchGitHubEvidence(
      target,
      fixture({
        runs: { total_count: 1, check_runs: [{ ...check, conclusion }] },
      }).fetcher,
    );
    assert.equal(evidence.checks.state, "failed");
  }
  const pending = await fetchGitHubEvidence(
    target,
    fixture({
      runs: {
        total_count: 1,
        check_runs: [{ ...check, status: "in_progress", conclusion: null }],
      },
    }).fetcher,
  );
  assert.equal(pending.checks.state, "pending");
});

test("malformed, foreign and mismatched pull evidence fails closed", async () => {
  for (const firstPull of [
    { ...pull, number: 8 },
    { ...pull, html_url: `${pull.html_url}?pretend=true` },
    { ...pull, head: { ...pull.head, sha: "not-a-sha" } },
    { ...pull, head: { ...pull.head, ref: "other" } },
    { ...pull, base: { ...pull.base, ref: "other" } },
    {
      ...pull,
      head: {
        ...pull.head,
        repo: { full_name: "foreign/fork", private: false },
      },
    },
    {
      ...pull,
      head: { ...pull.head, repo: { ...pull.head.repo, private: true } },
    },
    {
      ...pull,
      base: { ...pull.base, repo: { ...pull.base.repo, private: true } },
    },
    { ...pull, merged: true },
    { ...pull, merged_at: "2026-10-27T12:00:00Z" },
  ]) {
    await assert.rejects(
      fetchGitHubEvidence(target, fixture({ firstPull }).fetcher),
    );
  }
});

test("mixed commit SHAs, incomplete or saturated collections cannot pass verification", async () => {
  for (const overrides of [
    { runs: { ...checks, total_count: 2 } },
    { combined: { ...statuses, total_count: 1 } },
    {
      runs: {
        total_count: 100,
        check_runs: Array.from({ length: 100 }, () => check),
      },
    },
    {
      combined: {
        sha: head,
        total_count: 100,
        statuses: Array.from({ length: 100 }, () => ({
          context: "verify",
          state: "success",
          target_url: null,
        })),
      },
    },
    { runs: { ...checks, check_runs: [{ ...check, head_sha: merge }] } },
    { combined: { ...statuses, sha: merge } },
    { runs: { ...checks, check_runs: [{ ...check, status: "invented" }] } },
  ]) {
    await assert.rejects(
      fetchGitHubEvidence(target, fixture(overrides).fetcher),
    );
  }
  await assert.rejects(
    fetchGitHubEvidence(
      target,
      fixture({
        respond: (url) =>
          url.includes("/check-runs?")
            ? Response.json(checks, {
                headers: { Link: '<https://api.github.com/next>; rel="next"' },
              })
            : undefined,
      }).fetcher,
    ),
  );
});

test("pull drift between reads rejects mixed snapshots", async () => {
  for (const lastPull of [
    { ...pull, head: { ...pull.head, sha: merge } },
    { ...pull, state: "closed" },
    { ...pull, draft: true },
    { ...pull, base: { ...pull.base, ref: "other" } },
  ])
    await assert.rejects(
      fetchGitHubEvidence(target, fixture({ lastPull }).fetcher),
    );
});

test("unsafe targets are rejected before any network read", async () => {
  for (const invalid of [
    { ...target, repository: "https://example.com/private" },
    { ...target, repository: "owner/.." },
    { ...target, repository: "owner/repo?token=private" },
    { ...target, branch: "../../other" },
    { ...target, branch: "hidden\nsource" },
    { ...target, requiredChecks: [] },
    { ...target, requiredChecks: ["verify", "verify"] },
    { ...target, disclosure: "original source" },
  ]) {
    assert.equal(githubTargetSchema.safeParse(invalid).success, false);
    const { fetcher, requests } = fixture();
    await assert.rejects(fetchGitHubEvidence(invalid, fetcher));
    assert.equal(requests.length, 0);
  }
});

test("redirects, oversized declared and streamed bodies are rejected without following or accumulating them", async () => {
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://private.example/secret" },
    }),
    new Response("{}", {
      headers: { "content-length": String(1024 * 1024 + 1) },
    }),
    new Response("invalid json"),
    new Response(new Uint8Array([0xff])),
  ]) {
    const { fetcher, requests } = fixture({ respond: () => response });
    await assert.rejects(fetchGitHubEvidence(target, fetcher));
    assert.equal(requests.length, 1);
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchGitHubEvidence(
      target,
      fixture({ respond: () => new Response(body) }).fetcher,
    ),
  );
  assert.equal(cancelled, true);
});
