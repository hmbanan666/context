import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { distractorNotes } from "../fixtures/curated/distractors.js";
import {
  buildContextPackage,
  searchGroundingReport,
} from "../src/context-package.js";
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
type Question = z.infer<typeof questionSchema>;

interface Row {
  readonly id: string;
  readonly kind: "on" | "off";
  readonly lang: "en" | "ru";
  readonly grounding: Grounding;
  readonly hit: boolean;
  readonly cosine: number;
  readonly margin: number;
  readonly background: number;
  readonly pass: boolean;
}

const corpus = "fixtures/curated/mira-quill";
const questionsPath = "fixtures/curated/questions.yaml";
const mixedOffPath = "fixtures/curated/mixed-off.yaml";

function passed(
  row: Pick<Row, "kind" | "grounding" | "hit">,
  off: "none" | "not-strong",
): boolean {
  if (row.kind === "off")
    return off === "none"
      ? row.grounding === "none"
      : row.grounding !== "strong";
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

async function loadQuestions(path: string) {
  return fileSchema.parse(
    parseDocument(await readFile(path, "utf8"), {
      uniqueKeys: true,
    }).toJS({ maxAliasCount: 0 }),
  );
}

async function scoreQuestions(
  store: SourceStore,
  knowledge: KnowledgeStore,
  area: string,
  project: string,
  questions: readonly Question[],
  off: "none" | "not-strong",
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
    const explained = searchGroundingReport(pack);
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
      margin: explained?.margin ?? 0,
      background: explained?.background ?? 0,
      pass: passed({ kind: question.kind, grounding, hit }, off),
    });
  }
  return rows;
}

function report(
  mode: string,
  rows: readonly Row[],
  off: "none" | "not-strong",
) {
  const counts = tally(rows);
  const offLabel = off === "none" ? "none" : "not-strong";
  const levels = { strong: 0, weak: 0, none: 0 };
  for (const row of rows) {
    if (row.kind === "off") levels[row.grounding] += 1;
  }
  process.stdout.write(
    `${mode}: on-topic ${counts.onPass}/${counts.onTotal} not-none with the right source, off-topic ${counts.offPass}/${counts.offTotal} ${offLabel}`,
  );
  if (off === "not-strong") {
    process.stdout.write(
      ` (none ${levels.none}, weak ${levels.weak}, strong ${levels.strong})`,
    );
  }
  process.stdout.write("\n");
  if (rows.some((row) => row.cosine > 0 || row.margin !== 0)) {
    const band = (name: string, values: readonly number[]) => {
      if (!values.length) return;
      const sorted = [...values].sort((a, b) => a - b);
      const p50 = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
      process.stdout.write(
        `  ${name} min ${(sorted[0] ?? 0).toFixed(3)} p50 ${p50.toFixed(3)} max ${(sorted.at(-1) ?? 0).toFixed(3)}\n`,
      );
    };
    for (const kind of ["on", "off"] as const) {
      const group = rows.filter((row) => row.kind === kind);
      band(
        `cosine ${kind}`,
        group.map((row) => row.cosine),
      );
      band(
        `margin ${kind}`,
        group.map((row) => row.margin),
      );
      band(
        `background ${kind}`,
        group.map((row) => row.background),
      );
    }
  }
  for (const row of rows) {
    if (row.pass) continue;
    process.stdout.write(
      `  miss ${row.id} ${row.lang} ${row.kind} grounding=${row.grounding} hit=${row.hit} cosine=${row.cosine.toFixed(3)} margin=${row.margin.toFixed(3)} background=${row.background.toFixed(3)}\n`,
    );
  }
  return (
    counts.onPass >= 9 &&
    counts.offPass >= 9 &&
    counts.onTotal >= 10 &&
    counts.offTotal >= 10
  );
}

function embeddingDirectory(): string | undefined {
  for (const dir of [resolve("models"), resolve(".output/models")]) {
    if (
      existsSync(
        join(dir, "Xenova/multilingual-e5-small/onnx/model_quantized.onnx"),
      )
    )
      return dir;
  }
  return undefined;
}

async function writeDistractors(root: string) {
  const notes = distractorNotes();
  for (const item of notes) {
    const full = join(root, item.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, item.markdown);
  }
  return notes.length;
}

async function runSet(input: {
  databasePath: string;
  area: string;
  project: string;
  projectName: string;
  questions: readonly Question[];
  directories: readonly string[];
  off: "none" | "not-strong";
  label: string;
  added: number;
}) {
  const store = new SourceStore(input.databasePath);
  const knowledge = new KnowledgeStore(input.databasePath);
  try {
    store.createProject({
      id: input.project,
      name: input.projectName,
      homeArea: input.area,
    });
    let added = 0;
    for (const directory of input.directories) {
      const summary = await importMarkdown(store, directory, {
        areas: [input.area],
        area: input.area,
        project: input.project,
      });
      assert.equal(summary.rejected, 0, JSON.stringify(summary));
      added += summary.added;
    }
    assert.equal(added, input.added, JSON.stringify({ added }));
    const lexical = await scoreQuestions(
      store,
      knowledge,
      input.area,
      input.project,
      input.questions,
      input.off,
      async () => undefined,
    );
    const lexicalOk = report(`${input.label} lexical`, lexical, input.off);
    let semanticOk = true;
    let semanticRan = false;
    const modelDir = embeddingDirectory();
    if (!modelDir) {
      process.stdout.write(
        `${input.label} semantic: unavailable (model files not present)\n`,
      );
    } else {
      const index = new EmbeddingIndex(
        input.databasePath,
        localEmbedder(modelDir),
      );
      try {
        await index.load();
        await index.reindexEmbeddings(8, () => {});
        semanticRan = true;
        const semantic = await scoreQuestions(
          store,
          knowledge,
          input.area,
          input.project,
          input.questions,
          input.off,
          (question) =>
            index.search({
              scope: input.area,
              question,
              projectId: input.project,
            }),
        );
        semanticOk = report(`${input.label} semantic`, semantic, input.off);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unavailable";
        process.stdout.write(
          `${input.label} semantic: unavailable (${message})\n`,
        );
      } finally {
        await index.close();
      }
    }
    return lexicalOk && (!semanticRan || semanticOk);
  } finally {
    knowledge.close();
    store.close();
  }
}

const directory = await mkdtemp(join(tmpdir(), "context-grounding-"));
try {
  const curated = await loadQuestions(questionsPath);
  const mixedOff = await loadQuestions(mixedOffPath);
  assert.equal(curated.area, mixedOff.area);
  assert.equal(curated.project, mixedOff.project);
  const onTopic = curated.questions.filter(
    (question) => question.kind === "on",
  );
  const curatedOff = curated.questions.filter(
    (question) => question.kind === "off",
  );
  assert.equal(onTopic.length, 10);
  assert.equal(curatedOff.length, 10);
  assert.equal(mixedOff.questions.length, 10);
  assert.ok(mixedOff.questions.every((question) => question.kind === "off"));
  const distractorDir = join(directory, "distractors");
  const distractors = await writeDistractors(distractorDir);
  assert.ok(distractors >= 300);
  const curatedOk = await runSet({
    databasePath: join(directory, "curated.db"),
    area: curated.area,
    project: curated.project,
    projectName: "Mira Quill",
    questions: curated.questions,
    directories: [corpus],
    off: "none",
    label: "curated",
    added: 10,
  });
  const mixedOk = await runSet({
    databasePath: join(directory, "mixed.db"),
    area: curated.area,
    project: curated.project,
    projectName: "Mira Quill",
    questions: [...onTopic, ...mixedOff.questions],
    directories: [corpus, distractorDir],
    off: "not-strong",
    label: "mixed",
    added: 10 + distractors,
  });
  if (!curatedOk || !mixedOk) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
