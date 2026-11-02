import { KnowledgeStore } from "../../src/knowledge.js";
import { SourceStore } from "../../src/store.js";

export function seedEvalCorpus(path: string) {
  const sources = new SourceStore(path);
  try {
    const notes = [
      ["garden", "iris", "The cobalt iris needs shade."],
      ["garden", "lilies", "The lilies grow beside the pond."],
      ["garden", "storage", "The amber seeds are stored in a blue jar."],
      ["garden", "violet", "Фиалка растёт возле окна."],
      ["garden", "storage-ru", "Семена лежат в синей банке."],
      ["vault", "hidden", "The cobalt iris private recipe is violet."],
    ] as const;
    for (const [scope, id, text] of notes)
      sources.captureMaterial({
        version: 1,
        scope,
        origin: "synthetic:eval",
        idempotencyKey: id,
        text,
        metadata: { sourceUri: `https://fictional.example/${id}` },
      });
    new KnowledgeStore(path).close();
  } finally {
    sources.close();
  }
}
