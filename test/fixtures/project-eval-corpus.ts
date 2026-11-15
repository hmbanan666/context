import { KnowledgeStore } from "../../src/knowledge.js";
import { SourceStore } from "../../src/store.js";

// Fictional project-eval corpus. Russian questions live in
// fixtures/evals/projects.yaml. Nothing here is a production note.
const contextNotes = [
  "ADR-0011 nightly tidy distills each source into a short proposed fact.",
  "Nightly off-host backups copy a SQLite snapshot to S3 or SFTP.",
  "Embedding reindex is resumable and writes progress without source text.",
  "Embedding rows store the model id beside each vector.",
  "The owner edits the project glossary of bilingual synonyms from the CLI.",
  "A journal paragraph names the project and the ISO week.",
  "The project profile stores purpose, rules and pinned decisions.",
  "The task pack ranks decisions and facts by the query.",
  "Nightly tidy skips a source that copies an eighty character prose span.",
  "Search keeps four tools named search, remember, read and timeline.",
  "Distillation resumes from a stored cursor on the next nightly run.",
  "The task pack reserves bytes for raw sources.",
  "The lantern color is a fictional violet.",
];
const expiNotes = [
  "The fictional expi catalog lists prices in test currency.",
  "A synthetic subscription renews on the first day of the month.",
  "Checkout creates one fictional payment event.",
  "The billing queue retries a failed fictional charge.",
  "Audience preview counts synthetic members only.",
  "A price row is a test currency amount.",
  "The fictional invoice emails a receipt.",
  "An entitlement grants a synthetic feature flag.",
  "The campaign report sums fictional revenue.",
  "A webhook stores the fictional payment status.",
  "The ledger records a synthetic refund.",
  "Support macros answer a fictional billing question.",
];

export function seedProjectEvalCorpus(path: string) {
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  try {
    sources.createProject({
      id: "context",
      name: "Context",
      homeArea: "projects",
    });
    sources.createProject({
      id: "expi",
      name: "Expi",
      homeArea: "projects",
    });
    sources.setProfile({
      projectId: "context",
      purpose: "Hold fictional context notes.",
      rules: "Synthetic rules only.",
    });
    sources.setProfile({
      projectId: "expi",
      purpose: "Hold fictional expi notes.",
      rules: "Synthetic rules only.",
    });
    sources.setGlossaryTerm({
      projectId: "context",
      term: "дистилляция",
      synonyms: ["distill", "distillation", "tidy"],
    });
    for (const [term, synonyms] of [
      ["каталог", ["catalog"]],
      ["подписка", ["subscription"]],
      ["оплата", ["payment", "checkout"]],
      ["цена", ["price"]],
      ["очередь", ["queue"]],
      ["аудитория", ["audience"]],
      ["инвойс", ["invoice"]],
      ["лицензия", ["entitlement"]],
      ["кампания", ["campaign"]],
      ["вебхук", ["webhook"]],
      ["возврат", ["refund"]],
      ["биллинг", ["billing"]],
    ] as const)
      sources.setGlossaryTerm({ projectId: "expi", term, synonyms });
    const save = (project: string, notes: readonly string[]) => {
      notes.forEach((text, index) => {
        const createdAt = `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
        const source = sources.captureMaterial(
          {
            version: 1,
            scope: "projects",
            origin: "synthetic:project-eval",
            idempotencyKey: `${project}-${index}`,
            text,
            metadata: { title: `${project} ${index}`, createdAt },
          },
          undefined,
          [project],
        ).material.source;
        knowledge.addDistilled({
          scope: "projects",
          sourceId: source.id,
          kind: "decision",
          text,
          createdAt,
        });
      });
    };
    save("context", contextNotes);
    save("expi", expiNotes);
    const matrix = sources.captureMaterial(
      {
        version: 1,
        scope: "projects",
        origin: "synthetic:project-eval",
        idempotencyKey: "expi-matrix-pr",
        text: "Добавить таймфрейм на график Matrix. matrix-window-pr discusses the control.",
        metadata: {
          title: "expi matrix",
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      },
      undefined,
      ["expi"],
    ).material.source;
    knowledge.addDistilled({
      scope: "projects",
      sourceId: matrix.id,
      kind: "decision",
      text: "Ship the saved window control on that panel.",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
  } finally {
    knowledge.close();
    sources.close();
  }
}
