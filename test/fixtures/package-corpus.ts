import type { KnowledgeStore } from "../../src/knowledge.js";
import type { SourceStore } from "../../src/store.js";

export const scope = "private:personal";
export const period = {
  from: "2026-10-01T00:00:00+02:00",
  until: "2026-11-01T00:00:00+01:00",
};
export const questions = [
  {
    id: "overview",
    question: "Что происходило в октябре?",
    keywords: undefined,
    mode: "timeline",
    expected: [
      "launch",
      "flood",
      "budget",
      "story",
      "rescue",
      "long",
      "boundary",
    ],
  },
  {
    id: "book",
    question: "Какие истории подходят для книги?",
    keywords: "истории книги",
    expected: ["story", "rescue"],
  },
  {
    id: "delay",
    question: "Why did the amber launch slip?",
    keywords: "amber launch slip",
    expected: ["launch", "flood"],
  },
  {
    id: "budget",
    question: "What was the copper budget?",
    keywords: "copper budget",
    expected: ["budget"],
  },
  {
    id: "long",
    question: "What did the cobalt telescope reveal?",
    keywords: "cobalt telescope",
    expected: ["long"],
  },
  {
    id: "rescue",
    question: "Как команда спасла экспедицию?",
    keywords: "команда спасла экспедицию",
    expected: ["rescue"],
  },
  {
    id: "boundary",
    question: "What happened at the timezone boundary?",
    keywords: "timezone boundary",
    expected: ["boundary"],
  },
  {
    id: "paraphrase",
    question: "Who overcame adversity?",
    keywords: "overcame adversity",
    expected: ["rescue"],
  },
  {
    id: "inflection",
    question: "Что известно о телескопах?",
    keywords: "телескопах",
    expected: ["long"],
  },
  {
    id: "absent",
    question: "Where is the platinum submarine?",
    keywords: "platinum submarine",
    expected: [],
  },
] as const;

// Required verbatim facts in original evidence, independently scored after retrieval.
export const facts: Record<string, string> = {
  launch: "slipped by two days",
  flood: "river flooding closed the runway",
  budget: "120 tokens allocated, 90 tokens spent, 30 tokens left",
  story: "увидел комету после десяти неудачных ночей",
  rescue: "отряд нашёл дорогу домой",
  long: "three blue rings",
  boundary: "belongs to October in Berlin",
};

// Frozen fictional facts and relevance labels. The retriever never receives this oracle.
export function seedPackageCorpus(
  sources: SourceStore,
  knowledge: KnowledgeStore,
) {
  const labels = new Map<string, string>();
  const ids: Record<string, string> = {};
  const notes = [
    [
      "launch",
      "2026-10-03T12:00:00Z",
      "Synthetic amber launch: the test flight slipped by two days. The team kept the revised plan.",
    ],
    [
      "flood",
      "2026-10-04T12:00:00Z",
      "Synthetic river flooding closed the runway. Engineers waited for the water to recede.",
    ],
    [
      "budget",
      "2026-10-06T12:00:00Z",
      "Synthetic copper budget: 120 tokens allocated, 90 tokens spent, 30 tokens left.",
    ],
    [
      "story",
      "2026-10-08T12:00:00Z",
      "Вымышленная запись: бумажный астроном впервые увидел комету после десяти неудачных ночей.",
    ],
    [
      "rescue",
      "2026-10-09T12:00:00Z",
      "Вымышленная запись: проводник вернулся за потерянным компасом, и отряд нашёл дорогу домой.",
    ],
    [
      "long",
      "2026-10-11T12:00:00Z",
      "Synthetic log. ".repeat(350) +
        "The cobalt telescope revealed three blue rings. Телескоп показал три кольца. " +
        "Fictional appendix. ".repeat(90),
    ],
    [
      "boundary",
      "2026-11-01T00:30:00+02:00",
      "Synthetic timezone boundary observation belongs to October in Berlin.",
    ],
    [
      "excluded",
      "2026-11-01T00:00:00+01:00",
      "Synthetic timezone boundary observation belongs to November in Berlin.",
    ],
    [
      "old",
      "2026-09-15T12:00:00Z",
      "Synthetic amber launch from September is outside the requested period.",
    ],
  ];
  for (const [label, date, text] of notes) {
    if (!label || !date || !text) throw new Error("Invalid fixture");
    const m = sources.captureMaterial({
      version: 1,
      scope,
      text,
      origin: "fixture:package",
      idempotencyKey: label,
      metadata: { createdAt: date, title: label },
    }).material;
    ids[label] = m.source.id;
    labels.set(m.source.id, label);
  }
  const add = (label: string, text: string) =>
    knowledge.add({
      version: 1,
      scope,
      kind: "observation",
      text,
      sourceRefs: [{ sourceId: ids[label] ?? "missing" }],
      creator: { kind: "model", name: "synthetic-fixture" },
      idempotencyKey: label,
    }).item;
  const launch = add(
    "launch",
    "Synthetic amber launch delay: departure moved by two days.",
  );
  const flood = add("flood", "Synthetic flooding explains the runway closure.");
  knowledge.relate({
    version: 1,
    scope,
    kind: "supports",
    fromId: flood.id,
    toId: launch.id,
    sourceRefs: [{ sourceId: ids.flood ?? "missing" }],
    creator: { kind: "model", name: "synthetic-fixture" },
    idempotencyKey: "cause",
  });
  add(
    "story",
    "Вымышленные истории для книги: упорство астронома после десяти неудач.",
  );
  add(
    "rescue",
    "Вымышленные истории для книги: команда спасла экспедицию благодаря проводнику.",
  );
  for (let i = 0; i < 120; i++) {
    const m = sources.captureMaterial({
      version: 1,
      scope,
      origin: "fixture:package",
      idempotencyKey: `noise-${i}`,
      text:
        `Synthetic routine inventory ${i}. ` +
        "Paper clips and blank folders were counted. ".repeat(15),
      metadata: { createdAt: "2026-12-01T12:00:00Z" },
    }).material;
    labels.set(m.source.id, `noise-${i}`);
    knowledge.add({
      version: 1,
      scope,
      kind: "observation",
      text: `Synthetic inventory checklist ${i}.`,
      sourceRefs: [{ sourceId: m.source.id }],
      creator: { kind: "model", name: "synthetic-fixture" },
      idempotencyKey: `noise-${i}`,
    });
  }
  sources.captureMaterial({
    version: 1,
    scope: "synthetic:forbidden",
    origin: "fixture:package",
    idempotencyKey: "hidden",
    text: "Secret platinum submarine amber launch stories книги",
    metadata: { createdAt: "2026-10-05T00:00:00Z" },
  });
  return { labels, ids };
}
