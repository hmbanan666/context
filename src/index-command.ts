import { EmbeddingIndex } from "./embedding-index.js";
import { E5_VERSION } from "./embedding-model.js";
import { KnowledgeStore } from "./knowledge.js";
import { SourceStore } from "./store.js";

// Filesystem access is owner authority, as with the backup CLI. These commands
// never allocate another model alongside the service's in-process worker.
export async function runIndexCommand(
  action: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (!action || action !== "rebuild")
    throw new Error("Usage: context index rebuild");
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const index = new EmbeddingIndex(path, {
    version: E5_VERSION,
    async embed() {
      throw new Error("CLI only queues embeddings");
    },
  });
  try {
    index.rebuild();
    process.stdout.write(`${JSON.stringify({ action, ...index.status() })}\n`);
  } finally {
    await index.close();
    knowledge.close();
    sources.close();
  }
}
