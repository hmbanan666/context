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
      sources.createProject({
        id: "lantern",
        name: "Lantern",
        homeArea: "workshop",
      });
      const timeframe = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "lantern-timeframe",
          text: "Early note that led to the chart timeframe rule.",
          metadata: { createdAt: "2026-01-15T00:00:00Z" },
        },
        undefined,
        ["lantern"],
      );
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: timeframe.material.source.id,
        kind: "decision",
        text: "The chart timeframe choice keeps the saved setting.",
        createdAt: "2026-01-15T00:00:00Z",
      });
      const legend = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "lantern-legend",
          text: "A chart legend uses blue ink on the fictional panel.",
          metadata: { createdAt: "2026-11-20T00:00:00Z" },
        },
        undefined,
        ["lantern"],
      );
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: legend.material.source.id,
        kind: "fact",
        text: "A chart legend uses blue.",
        createdAt: "2026-11-20T00:00:00Z",
      });
      for (let index = 0; index < 8; index++) {
        const note = sources.captureMaterial(
          {
            version: 1,
            scope: "workshop",
            origin: "synthetic:eval",
            idempotencyKey: `lantern-lamp-${index}`,
            text: `Lamp note ${index} records an unrelated violet shade.`,
            metadata: {
              createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
            },
          },
          undefined,
          ["lantern"],
        );
        knowledge.addDistilled({
          scope: "workshop",
          sourceId: note.material.source.id,
          kind: "fact",
          text: `Lamp note ${index} records an unrelated violet shade.`,
          createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        });
      }
      const russian = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "lantern-russian",
          text: "Исходная заметка про выбор таймфрейма.",
          metadata: { createdAt: "2026-02-01T00:00:00Z" },
        },
        undefined,
        ["lantern"],
      );
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: russian.material.source.id,
        kind: "decision",
        text: "Выбор таймфрейма сохраняет настройку графика.",
        createdAt: "2026-02-01T00:00:00Z",
      });
      const duty = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "lantern-duty",
          text: "Графика была обновлена в холле.",
          metadata: { createdAt: "2026-11-21T00:00:00Z" },
        },
        undefined,
        ["lantern"],
      );
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: duty.material.source.id,
        kind: "fact",
        text: "Графика была обновлена в холле.",
        createdAt: "2026-11-21T00:00:00Z",
      });
      const lamps = sources.captureMaterial(
        {
          version: 1,
          scope: "workshop",
          origin: "synthetic:eval",
          idempotencyKey: "lantern-lamps-ru",
          text: "Еженедельная заметка перечисляет цвета ламп.",
          metadata: { createdAt: "2026-11-22T00:00:00Z" },
        },
        undefined,
        ["lantern"],
      );
      knowledge.addDistilled({
        scope: "workshop",
        sourceId: lamps.material.source.id,
        kind: "fact",
        text: "Еженедельная заметка перечисляет цвета ламп.",
        createdAt: "2026-11-22T00:00:00Z",
      });
      sources.setProfile({
        projectId: "lantern",
        purpose: "Track the fictional lantern.",
        rules: "Keep the fictional notes short.",
        pinned: [],
      });
    } finally {
      knowledge.close();
    }
  } finally {
    sources.close();
  }
}
