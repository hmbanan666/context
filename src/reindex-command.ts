import { EmbeddingIndex } from "./embedding-index.js";
import { localEmbedder } from "./embedding-model.js";
import { KnowledgeStore } from "./knowledge.js";
import { SourceStore } from "./store.js";

const usage = "Usage: context reindex --embeddings [--batch N]";

// Owner filesystem authority, same as index rebuild. This command loads the
// local model and embeds; do not run it beside a busy server on a small VPS
// unless the memory limit can hold two copies.
export async function runReindexCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  let embeddings = false;
  let batch = 8;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--embeddings") {
      if (embeddings) throw new Error(usage);
      embeddings = true;
      continue;
    }
    if (arg === "--batch") {
      const value = args[++i];
      if (!value || !/^(?:[1-9]|[1-5][0-9]|64)$/.test(value))
        throw new Error("Batch must be 1–64");
      batch = Number(value);
      continue;
    }
    throw new Error(usage);
  }
  if (!embeddings) throw new Error(usage);
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const index = new EmbeddingIndex(path, localEmbedder());
  try {
    await index.load();
    await index.reindexEmbeddings(batch, (status) => {
      process.stdout.write(
        `${JSON.stringify({
          event: "reindex_progress",
          queued: status.queued,
          running: status.running,
          completed: status.completed,
          failed: status.failed,
          chunks: status.chunks,
          model: status.model,
          otherModels: status.otherModels,
        })}\n`,
      );
    });
  } finally {
    await index.close();
    knowledge.close();
    sources.close();
  }
}
