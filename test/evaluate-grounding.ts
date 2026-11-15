import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { buildContextPackage } from "../src/context-package.js";
import { EmbeddingIndex, type SemanticHits } from "../src/embedding-index.js";
import { localEmbedder } from "../src/embedding-model.js";
import type { Grounding } from "../src/grounding.js";
import { importMarkdown } from "../src/import-markdown.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";

const questionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  kind: z.enum(["on", "off"]),
  lang: z.enum(["en", "ru"]),
  question: z.string().min(1).max(512),
  path: z.string().min(1).max(256).optional(),
});
const fileSchema = z.strictObject({
  area: z.string().min(1),
  project: z.string().min(1),
  questions: z.array(questionSchema).min(1).max(100),
});

interface Row {
  readonly id: string;
  readonly kind: "on" | "off";
  readonly lang: "en" | "ru";
  readonly grounding: Grounding;
  readonly hit: boolean;
  readonly cosine: number;
  readonly pass: boolean;
}

const corpus = "fixtures/curated/mira-quill";
const questionsPath = "fixtures/curated/questions.yaml";

function passed(row: Pick<Row, "kind" | "grounding" | "hit">): boolean {
  if (row.kind === "off") return row.grounding === "none";
  return row.grounding !== "none" && row.hit;
}

function tally(rows: readonly Row[]) {
  const on = rows.filter((row) => row.kind === "on");
  const off = rows.filter((row) => row.kind === "off");
  return {
    onPass: on.filter((row) => row.pass).length,
    onTotal: on.length,
    offPass: off.filter((row) => row.pass).length,
    offTotal: off.length,
  };
}

async function scoreQuestions(
  store: SourceStore,
  knowledge: KnowledgeStore,
  area: string,
  project: string,
  questions: z.infer<typeof questionSchema>[],
  semanticFor: (question: string) => Promise<SemanticHits | undefined>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const question of questions) {
    const semantic = await semanticFor(question.question);
    const pack = buildContextPackage(
      store,
      knowledge,
      {
        version: 1,
        scope: area,
        question: question.question,
        limit: 8,
      },
      semantic,
      project,
    );
    const hit = question.path
      ? pack.sources.some((source) => {
          const external = store.findMaterial(source.id, area)?.import
            ?.externalId;
          return (
            external === question.path ||
            external?.startsWith(`${question.path}#`) === true
          );
        })
      : false;
    const grounding = pack.grounding ?? "none";
    const cosine = Math.max(
      0,
      ...(semantic?.sources.map((hit) => hit.score ?? 0) ?? []),
      ...(semantic?.items.map((hit) => hit.score ?? 0) ?? []),
    );
    rows.push({
      id: question.id,
      kind: question.kind,
      lang: question.lang,
      grounding,
      hit,
      cosine,
      pass: passed({ kind: question.kind, grounding, hit }),
    });
  }
  return rows;
}

function report(mode: string, rows: readonly Row[]) {
  const counts = tally(rows);
  process.stdout.write(
    `${mode}: on-topic ${counts.onPass}/${counts.onTotal} not-none with the right source, off-topic ${counts.offPass}/${counts.offTotal} none\n`,
  );
  if (rows.some((row) => row.cosine > 0)) {
    const offMax = Math.max(
      ...rows.filter((row) => row.kind === "off").map((row) => row.cosine),
    );
    const onMin = Math.min(
      ...rows.filter((row) => row.kind === "on").map((row) => row.cosine),
    );
    process.stdout.write(
      `  cosine off-topic max ${offMax.toFixed(3)}, on-topic min ${onMin.toFixed(3)}\n`,
    );
  }
  for (const row of rows) {
    if (row.pass) continue;
    process.stdout.write(
      `  miss ${row.id} ${row.lang} ${row.kind} grounding=${row.grounding} hit=${row.hit} cosine=${row.cosine.toFixed(3)}\n`,
    );
  }
  return (
    counts.onPass >= 9 &&
    counts.offPass >= 9 &&
    counts.onTotal >= 10 &&
    counts.offTotal >= 10
  );
}

const directory = await mkdtemp(join(tmpdir(), "context-grounding-"));
const databasePath = join(directory, "context.db");
try {
  const parsed = fileSchema.parse(
    parseDocument(await readFile(questionsPath, "utf8"), {
      uniqueKeys: true,
    }).toJS({ maxAliasCount: 0 }),
  );
  assert.equal(
    parsed.questions.filter((question) => question.kind === "on").length,
    10,
  );
  assert.equal(
    parsed.questions.filter((question) => question.kind === "off").length,
    10,
  );
  const store = new SourceStore(databasePath);
  const knowledge = new KnowledgeStore(databasePath);
  try {
    store.createProject({
      id: parsed.project,
      name: "Mira Quill",
      homeArea: parsed.area,
    });
    const summary = await importMarkdown(store, corpus, {
      areas: [parsed.area],
      area: parsed.area,
      project: parsed.project,
    });
    assert.equal(summary.rejected, 0, JSON.stringify(summary));
    assert.equal(summary.added, 10, JSON.stringify(summary));
    const lexical = await scoreQuestions(
      store,
      knowledge,
      parsed.area,
      parsed.project,
      parsed.questions,
      async () => undefined,
    );
    const lexicalOk = report("lexical", lexical);
    let semanticOk = true;
    let semanticRan = false;
    const embedder = localEmbedder();
    const index = new EmbeddingIndex(databasePath, embedder);
    try {
      await index.load();
      await index.reindexEmbeddings(8, () => {});
      semanticRan = true;
      const semantic = await scoreQuestions(
        store,
        knowledge,
        parsed.area,
        parsed.project,
        parsed.questions,
        (question) =>
          index.search({
            scope: parsed.area,
            question,
            projectId: parsed.project,
          }),
      );
      semanticOk = report("semantic", semantic);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unavailable";
      process.stdout.write(`semantic: unavailable (${message})\n`);
    } finally {
      await index.close();
    }
    if (!lexicalOk || (semanticRan && !semanticOk)) process.exitCode = 1;
  } finally {
    knowledge.close();
    store.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
