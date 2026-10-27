import { z } from "zod";

const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        ![...value].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => ![".", ".."].includes(value.split("/")[1] ?? ""));
const branchSchema = boundedText(256).refine(
  (value) =>
    !/[ ~^:?*[\\]/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("-") &&
    !value.endsWith(".") &&
    value !== "@" &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
      ),
);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const linkSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const checkNameSchema = boundedText(256);

export const githubTargetSchema = z.strictObject({
  repository: repositorySchema,
  branch: branchSchema,
  baseBranch: branchSchema,
  pullNumber: z.number().int().min(1).max(2147483647),
  requiredChecks: z
    .array(checkNameSchema)
    .min(1)
    .max(20)
    .refine((names) => new Set(names).size === names.length),
});
export type GitHubTarget = z.infer<typeof githubTargetSchema>;

const checkStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);
const conclusionSchema = z
  .enum([
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "success",
    "skipped",
    "stale",
    "timed_out",
    "startup_failure",
  ])
  .nullable();
const statusStateSchema = z.enum(["error", "failure", "pending", "success"]);
const runSchema = z.strictObject({
  name: checkNameSchema,
  status: checkStatusSchema,
  conclusion: conclusionSchema,
  url: linkSchema.nullable(),
  headSha: shaSchema,
});
const statusSchema = z.strictObject({
  context: checkNameSchema,
  state: statusStateSchema,
  url: linkSchema.nullable(),
});
const mergeSchema = z.strictObject({
  sha: shaSchema,
  mergedAt: z.iso.datetime(),
});

export const githubEvidenceSchema = z.strictObject({
  repository: repositorySchema,
  pullNumber: githubTargetSchema.shape.pullNumber,
  url: linkSchema,
  headSha: shaSchema,
  baseBranch: branchSchema,
  branch: branchSchema,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  createdAt: z.iso.datetime(),
  merge: mergeSchema.nullable(),
  checks: z.strictObject({
    state: z.enum(["passed", "failed", "pending", "unknown"]),
    runs: z.array(runSchema).max(100),
    statuses: z.array(statusSchema).max(100),
    required: githubTargetSchema.shape.requiredChecks,
  }),
  observedAt: z.iso.datetime(),
  provider: z.literal("github-rest"),
  deployment: z.literal("unverified"),
});
export type GitHubEvidence = z.infer<typeof githubEvidenceSchema>;

const publicRepositorySchema = z.object({
  full_name: repositorySchema,
  private: z.literal(false),
});
const pullSchema = z.object({
  number: githubTargetSchema.shape.pullNumber,
  html_url: linkSchema,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  created_at: z.iso.datetime(),
  merged_at: z.iso.datetime().nullable(),
  merge_commit_sha: shaSchema.nullable(),
  head: z.object({
    sha: shaSchema,
    ref: branchSchema,
    repo: publicRepositorySchema,
  }),
  base: z.object({ ref: branchSchema, repo: publicRepositorySchema }),
});
const rawRunsSchema = z.object({
  total_count: z.number().int().min(0).max(100),
  check_runs: z
    .array(
      z.object({
        name: checkNameSchema,
        status: checkStatusSchema,
        conclusion: conclusionSchema,
        html_url: linkSchema.nullable(),
        head_sha: shaSchema,
      }),
    )
    .max(100),
});
const rawStatusesSchema = z.object({
  sha: shaSchema,
  total_count: z.number().int().min(0).max(100),
  statuses: z
    .array(
      z.object({
        context: checkNameSchema,
        state: statusStateSchema,
        target_url: linkSchema.nullable(),
      }),
    )
    .max(100),
});
const responseLimit = 1024 * 1024;

async function readJson(response: Response): Promise<unknown> {
  if (
    !response.ok ||
    response.status !== 200 ||
    response.redirected ||
    response.headers.has("link")
  ) {
    await response.body?.cancel();
    throw new Error("GitHub evidence response unavailable or incomplete");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > responseLimit)
  ) {
    await response.body?.cancel();
    throw new Error("GitHub evidence response exceeds limit");
  }
  if (!response.body) throw new Error("Missing GitHub evidence response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > responseLimit) {
        await reader.cancel();
        throw new Error("GitHub evidence response exceeds limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

function checksState(
  runs: GitHubEvidence["checks"]["runs"],
  statuses: GitHubEvidence["checks"]["statuses"],
  required: string[],
): GitHubEvidence["checks"]["state"] {
  if (
    statuses.some((status) => ["error", "failure"].includes(status.state)) ||
    runs.some(
      (run) =>
        run.conclusion !== null &&
        [
          "action_required",
          "cancelled",
          "failure",
          "stale",
          "timed_out",
          "startup_failure",
        ].includes(run.conclusion),
    )
  ) {
    return "failed";
  }
  if (
    statuses.some((status) => status.state === "pending") ||
    runs.some((run) => run.status !== "completed")
  )
    return "pending";
  return required.every((name) => {
    const matchingRuns = runs.filter((run) => run.name === name);
    const matchingStatuses = statuses.filter(
      (status) => status.context === name,
    );
    return (
      matchingRuns.length + matchingStatuses.length > 0 &&
      matchingRuns.every(
        (run) => run.status === "completed" && run.conclusion === "success",
      ) &&
      matchingStatuses.every((status) => status.state === "success")
    );
  })
    ? "passed"
    : "unknown";
}

// Explicit operator read only: no source content, credentials, caller URL or writes.
export async function fetchGitHubEvidence(
  input: GitHubTarget,
  fetcher: typeof fetch = fetch,
): Promise<GitHubEvidence> {
  const target = githubTargetSchema.parse(input);
  const root = `https://api.github.com/repos/${target.repository}`;
  const pullUrl = `${root}/pulls/${target.pullNumber}`;
  const expectedUrl = `https://github.com/${target.repository}/pull/${target.pullNumber}`;
  const get = async (url: string): Promise<unknown> =>
    readJson(
      await fetcher(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }),
    );
  const pull = pullSchema.parse(await get(pullUrl));
  if (
    pull.number !== target.pullNumber ||
    pull.html_url.toLowerCase() !== expectedUrl.toLowerCase() ||
    pull.head.repo.full_name.toLowerCase() !==
      target.repository.toLowerCase() ||
    pull.base.repo.full_name.toLowerCase() !==
      target.repository.toLowerCase() ||
    pull.head.ref !== target.branch ||
    pull.base.ref !== target.baseBranch ||
    pull.merged !== (pull.merged_at !== null) ||
    (pull.merged &&
      (pull.state !== "closed" ||
        pull.merge_commit_sha === null ||
        Date.parse(pull.created_at) > Date.parse(pull.merged_at ?? "")))
  ) {
    throw new Error("GitHub pull request does not match authorization");
  }
  const head = pull.head.sha;
  const [rawRuns, rawStatuses] = await Promise.all([
    get(`${root}/commits/${head}/check-runs?filter=latest&per_page=100`),
    get(`${root}/commits/${head}/status?per_page=100`),
  ]);
  const checks = rawRunsSchema.parse(rawRuns);
  const combined = rawStatusesSchema.parse(rawStatuses);
  if (
    checks.total_count >= 100 ||
    combined.total_count >= 100 ||
    checks.total_count !== checks.check_runs.length ||
    combined.total_count !== combined.statuses.length ||
    combined.sha !== head ||
    checks.check_runs.some((run) => run.head_sha !== head)
  ) {
    throw new Error(
      "GitHub check evidence is incomplete or belongs to another commit",
    );
  }
  const confirmed = pullSchema.parse(await get(pullUrl));
  if (JSON.stringify(pull) !== JSON.stringify(confirmed)) {
    throw new Error("GitHub pull request changed during evidence collection");
  }
  const runs = checks.check_runs.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    headSha: run.head_sha,
  }));
  const statuses = combined.statuses.map((status) => ({
    context: status.context,
    state: status.state,
    url: status.target_url,
  }));
  return githubEvidenceSchema.parse({
    repository: target.repository,
    pullNumber: target.pullNumber,
    url: expectedUrl,
    headSha: head,
    branch: target.branch,
    baseBranch: target.baseBranch,
    state: pull.state,
    draft: pull.draft,
    createdAt: pull.created_at,
    merge: pull.merged
      ? { sha: pull.merge_commit_sha, mergedAt: pull.merged_at }
      : null,
    checks: {
      state: checksState(runs, statuses, target.requiredChecks),
      runs,
      statuses,
      required: target.requiredChecks,
    },
    observedAt: new Date().toISOString(),
    provider: "github-rest",
    deployment: "unverified",
  });
}
