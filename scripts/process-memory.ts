import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { extractWithCodex } from "../src/codex-extractor.js";
import { scopeSchema } from "../src/contracts.js";
import { JobStore } from "../src/jobs.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { processNext } from "../src/processor.js";
import { SourceStore } from "../src/store.js";

async function main(): Promise<void> {
  const [database, scope, mode, extra] = process.argv.slice(2);
  if (
    !database ||
    !scope ||
    !["--once", "--drain"].includes(mode ?? "") ||
    extra !== undefined
  ) {
    throw new Error(
      "Usage: process-memory DATABASE SYNTHETIC_SCOPE --once|--drain",
    );
  }
  scopeSchema.parse(scope);
  const path = resolve(database);
  if (!(await stat(path)).isFile()) throw new Error("database_unavailable");
  const sources = new SourceStore(path);
  let knowledge: KnowledgeStore | undefined;
  let jobs: JobStore | undefined;
  try {
    knowledge = new KnowledgeStore(path);
    jobs = new JobStore(path);
    const maximum = mode === "--once" ? 1 : 20;
    let processed = 0;
    for (; processed < maximum; processed++) {
      const job = await processNext(
        sources,
        knowledge,
        jobs,
        scope,
        extractWithCodex,
      );
      if (!job) break;
      if (job.status !== "completed") process.exitCode = 1;
      process.stdout.write(
        `${JSON.stringify({ id: job.id, status: job.status })}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify({ processed })}\n`);
  } finally {
    jobs?.close();
    knowledge?.close();
    sources.close();
  }
}

try {
  await main();
} catch {
  // Do not print exception details, database paths, model output or source text.
  process.stderr.write("memory_processing_failed\n");
  process.exitCode = 1;
}
