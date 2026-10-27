import type { GitHubTarget } from "../src/github-evidence.js";

// Public, deterministic API responses; no GitHub request is made by this fixture.
export function syntheticGitHubFetch(
  target: GitHubTarget,
  options: {
    merged?: boolean;
    state?: "open" | "closed";
    headSha?: string;
    checkState?: "passed" | "failed" | "pending" | "unknown";
    createdAt?: string;
  } = {},
): typeof fetch {
  const head = options.headSha ?? "a".repeat(40);
  const merged = options.merged ?? false;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const state = options.checkState ?? "passed";
  const root = `https://api.github.com/repos/${target.repository}`;
  return async (url) => {
    const address = String(url);
    if (address === `${root}/pulls/${target.pullNumber}`) {
      return Response.json({
        number: target.pullNumber,
        html_url: `https://github.com/${target.repository}/pull/${target.pullNumber}`,
        state: merged ? "closed" : (options.state ?? "open"),
        draft: false,
        merged,
        created_at: createdAt,
        merged_at: merged ? createdAt : null,
        merge_commit_sha: merged ? "b".repeat(40) : null,
        head: {
          sha: head,
          ref: target.branch,
          repo: { full_name: target.repository, private: false },
        },
        base: {
          ref: target.baseBranch,
          repo: { full_name: target.repository, private: false },
        },
      });
    }
    if (
      address ===
      `${root}/commits/${head}/check-runs?filter=latest&per_page=100`
    ) {
      const runs =
        state === "unknown"
          ? []
          : target.requiredChecks.map((name) => ({
              name,
              status: state === "pending" ? "in_progress" : "completed",
              conclusion:
                state === "pending"
                  ? null
                  : state === "failed"
                    ? "failure"
                    : "success",
              html_url: `https://github.com/${target.repository}/actions/runs/42`,
              head_sha: head,
            }));
      return Response.json({ total_count: runs.length, check_runs: runs });
    }
    if (address === `${root}/commits/${head}/status?per_page=100`) {
      return Response.json({ sha: head, total_count: 0, statuses: [] });
    }
    throw new Error("Unexpected synthetic GitHub request");
  };
}
