import { parseArgs } from "node:util";
import { collectGithub } from "../src/collect-github.js";
import { writeCollected } from "../src/collector-output.js";

async function main() {
  const { values } = parseArgs({
    options: {
      owner: { type: "string" },
      repos: { type: "string" },
      since: { type: "string" },
      "include-archived": { type: "boolean" },
      "include-forks": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.owner) throw new Error("Owner is required");
  const stats = { skipped: 0, errors: 0, repositories: 0 };
  await writeCollected(
    collectGithub(
      {
        owner: values.owner,
        ...(values.repos === undefined
          ? {}
          : { repos: values.repos.split(",") }),
        ...(values.since === undefined ? {} : { since: values.since }),
        includeArchived: values["include-archived"] ?? false,
        includeForks: values["include-forks"] ?? false,
      },
      undefined,
      stats,
    ),
  );
  process.stderr.write(`${JSON.stringify({ type: "collection", ...stats })}\n`);
  if (stats.errors) process.exitCode = 2;
}
void main().catch(() => {
  process.stderr.write(
    '{"type":"error","reason":"github_collection_failed"}\n',
  );
  process.exitCode = 1;
});
