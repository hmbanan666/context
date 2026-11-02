import { EmbeddingIndex } from "./embedding-index.js";
import { type Embedder, localEmbedder } from "./embedding-model.js";
import { type EvalOptions, evaluate } from "./eval-runner.js";

// Only the standalone owner CLI owns a model. Nightly runs borrow the server index.
export async function evaluateWithLocalModel(
  options: EvalOptions,
  embedder: Embedder = localEmbedder(),
) {
  let index: EmbeddingIndex | undefined;
  try {
    index = new EmbeddingIndex(options.databasePath, embedder, {
      readOnly: true,
    });
    // No backfill, migration or cache writes. With no current vectors there is
    // nothing semantic to measure, and evaluate reports semantic: unavailable.
    if (index.hasVectors()) await index.load().catch(() => {});
    return await evaluate(options, index);
  } catch {
    const run = await evaluate(options);
    run.outcome = "failed";
    return run;
  } finally {
    await index?.close();
  }
}
