import { KnowledgeStore } from "../../src/knowledge.js";
import { SourceStore } from "../../src/store.js";

const packPurpose = "Track the fictional observatory dome.";
const packDecision =
  "Dome motors stay disabled until the shutter is confirmed closed.";

// Purpose, rules, then the pinned sentence: 1400 bytes, decision after byte 512.
function packRules(): string {
  const sentence = "Keep the fictional dome dark during daylight.";
  const target = 1400;
  const size = (rules: string) =>
    Buffer.byteLength(`${packPurpose}\n${rules}\n${packDecision}`, "utf8");
  let rules = "";
  while (size(rules ? `${rules} ${sentence}` : sentence) <= target)
    rules = rules ? `${rules} ${sentence}` : sentence;
  const gap = target - size(rules);
  if (gap > 0) {
    const period = rules.lastIndexOf(".");
    rules = `${rules.slice(0, period)}${" ".repeat(gap)}${rules.slice(period)}`;
  }
  return rules;
}

// Fictional October records for fixtures/evals/project-memory.yaml.
// Pack records are dated outside October so the month question stays put.
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
      const pinSource = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "dome-motor-note",
          text: "September note that led to the dome motor rule.",
          metadata: { createdAt: "2026-09-02T00:00:00Z" },
        },
        undefined,
        ["observatory"],
      );
      const pinned = knowledge.addDistilled({
        scope: "workshop",
        sourceId: pinSource.material.source.id,
        kind: "decision",
        text: packDecision,
        createdAt: "2026-09-02T00:00:00Z",
      }).item;
      const sensor = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "shutter-sensor",
          text: `${"Field log of the fictional shutter sensor. ".repeat(12)}raw shutter wiring dump follows this marker.`,
          metadata: {
            createdAt: "2026-11-20T00:00:00Z",
            sourceUri: "https://fictional.example/observatory/sensor",
          },
        },
        undefined,
        ["observatory"],
      );
      const reading = knowledge.addDistilled({
        scope: "workshop",
        sourceId: sensor.material.source.id,
        kind: "fact",
        text: "The shutter sensor reports open or closed.",
        createdAt: "2026-11-20T00:00:00Z",
      }).item;
      const notebookRule = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "notebook-pin",
          text: "September note from the other undertaking.",
          metadata: { createdAt: "2026-09-03T00:00:00Z" },
        },
        undefined,
        ["notebook"],
      );
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: notebookRule.material.source.id,
        kind: "decision",
        text: "The notebook project pins its index.",
        createdAt: "2026-09-03T00:00:00Z",
      });
      knowledge.decideProposals({
        action: "approved",
        areas: ["workshop"],
        timeZone: "UTC",
        ids: [pinned.id, reading.id],
      });
      sources.setProfile({
        projectId: "observatory",
        purpose: packPurpose,
        rules: packRules(),
        pinned: [pinned.id],
      });
    } finally {
      knowledge.close();
    }
  } finally {
    sources.close();
  }
}
