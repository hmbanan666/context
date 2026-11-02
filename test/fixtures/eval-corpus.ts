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
      ["garden", "agents-old", "Synthetic lunar agents limit 3. Lunar agents."],
      [
        "garden",
        "agents-current",
        "Synthetic lunar agents limit 4 with the current staffing decision.",
      ],
      ["garden", "canonical", "Synthetic telescope maintenance schedule."],
      [
        "garden",
        "duplicate",
        "Synthetic telescope maintenance schedule, uniquecopyalias.",
      ],
      ["vault", "hidden", "The cobalt iris private recipe is violet."],
    ] as const;
    const ids = new Map<string, string>();
    for (const [scope, id, text] of notes) {
      const saved = sources.captureMaterial({
        version: 1,
        scope,
        origin: "synthetic:eval",
        idempotencyKey: id,
        text,
        metadata: { sourceUri: `https://fictional.example/${id}` },
      });
      ids.set(id, saved.material.source.id);
    }
    const knowledge = new KnowledgeStore(path);
    for (const [kind, from, to] of [
      ["supersedes", "agents-current", "agents-old"],
      ["duplicates", "duplicate", "canonical"],
    ] as const) {
      const id = (name: string) => {
        const found = ids.get(name);
        if (!found) throw new Error("Missing fixture source");
        return found;
      };
      knowledge.relate({
        version: 1,
        scope: "garden",
        idempotencyKey: from,
        kind,
        fromId: id(from),
        toId: id(to),
        sourceRefs: [{ sourceId: id(from) }],
        creator: { kind: "user", name: "synthetic" },
      });
    }
    knowledge.close();
  } finally {
    sources.close();
  }
}
