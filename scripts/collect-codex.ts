import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { collectCodex } from "../src/collect-codex.js";
import { writeCollected } from "../src/collector-output.js";

async function main() {
  const { values } = parseArgs({
    options: {
      sessions: {
        type: "string",
        default: join(homedir(), ".codex", "sessions"),
      },
      tasks: { type: "string" },
    },
    strict: true,
  });
  const stats = { skipped: 0, errors: 0 };
  await writeCollected(
    collectCodex(
      {
        sessions: values.sessions,
        ...(values.tasks === undefined ? {} : { tasks: values.tasks }),
      },
      stats,
    ),
  );
  process.stderr.write(`${JSON.stringify({ type: "collection", ...stats })}\n`);
  if (stats.errors) process.exitCode = 2;
}
void main().catch(() => {
  process.stderr.write('{"type":"error","reason":"codex_collection_failed"}\n');
  process.exitCode = 1;
});
