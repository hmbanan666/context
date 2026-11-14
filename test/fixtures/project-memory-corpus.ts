import { KnowledgeStore } from "../../src/knowledge.js";
import { SourceStore } from "../../src/store.js";

// Fictional October records for fixtures/evals/project-memory.yaml.
export function seedProjectMemoryCorpus(path: string) {
  const sources = new SourceStore(path);
  try {
    sources.createProject({
      id: "observatory",
      name: "Observatory",
      homeArea: "workshop",
    });
    sources.createProject({
      id: "notebook",
      name: "Notebook",
      homeArea: "workshop",
    });
    const observatory = sources.captureMaterial(
      {
        version: 1,
        scope: "workshop",
        origin: "synthetic:eval",
        idempotencyKey: "observatory-pr",
        text: "Pull request archive for the observatory work. diff hunk discussion continues below.",
        metadata: {
          title: "Cobalt mirror mount",
          createdAt: "2026-10-12T00:00:00Z",
          sourceUri: "https://fictional.example/observatory/pr/14",
        },
      },
      undefined,
      ["observatory"],
    );
    const notebook = sources.captureMaterial(
      {
        version: 1,
        scope: "workshop",
        origin: "synthetic:eval",
        idempotencyKey: "notebook-pr",
        text: "Notebook archive note for a different undertaking.",
        metadata: {
          title: "Notebook index",
          createdAt: "2026-10-18T00:00:00Z",
          sourceUri: "https://fictional.example/notebook/pr/2",
        },
      },
      undefined,
      ["notebook"],
    );
    const knowledge = new KnowledgeStore(path);
    try {
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: observatory.material.source.id,
        kind: "fact",
        text: "In October 2026 the observatory project shipped the cobalt mirror mount.",
        createdAt: "2026-10-12T00:00:00Z",
      });
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: notebook.material.source.id,
        kind: "fact",
        text: "In October 2026 the notebook project renamed its index.",
        createdAt: "2026-10-18T00:00:00Z",
      });
    } finally {
      knowledge.close();
    }
  } finally {
    sources.close();
  }
}
