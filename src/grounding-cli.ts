import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { ZodError, z } from "zod";
import {
  buildContextPackage,
  searchGroundingReport,
  searchTopHit,
} from "./context-package.js";
import { scopeSchema } from "./contracts.js";
import { EmbeddingIndex } from "./embedding-index.js";
import { localEmbedder } from "./embedding-model.js";
import type { Grounding, GroundingReport } from "./grounding.js";
import { KnowledgeStore } from "./knowledge.js";
import { projectIdSchema } from "./projects.js";
import { SourceStore } from "./store.js";

const usage =
  "Usage: context grounding explain (--query <text> | --file <questions.yaml>) [--area <area>] [--project <id>] [--json]";

const questionSchema = z.strictObject({
  query: z.string().min(1).max(512),
  project: projectIdSchema.optional(),
  expect: z.enum(["on", "off"]),
});

type Expectation = "on" | "off";

export interface ExplainRow {
  readonly query: string;
  readonly area: string;
  readonly project?: string;
  readonly expect?: Expectation;
  readonly grounding: Grounding;
  readonly cosine: number;
  readonly background: number;
  readonly margin: number;
  readonly rareShare: number;
  readonly matchedRare: readonly string[];
  readonly commonDropped: readonly string[];
  readonly corpus: number;
  readonly documentFrequency: GroundingReport["documentFrequency"];
  readonly thresholds: GroundingReport["thresholds"];
  readonly vectors: boolean;
  readonly topHit: { readonly id: string; readonly title: string } | null;
}

export interface ClassDistribution {
  readonly n: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly max: number | null;
}

export interface ClassScore {
  readonly onCorrect: number;
  readonly onTotal: number;
  readonly offCorrect: number;
  readonly offTotal: number;
}

export interface FeatureCut extends ClassScore {
  /** `null` predicts every query off (`feature > 1`). */
  readonly cut: number | null;
}

export interface CombinedCut extends ClassScore {
  readonly op: "and" | "or";
  readonly rareShare: number | null;
  readonly margin: number | null;
}

export interface SeparationSummary {
  readonly cosine: { on: ClassDistribution; off: ClassDistribution };
  readonly rareShare: { on: ClassDistribution; off: ClassDistribution };
  readonly margin: { on: ClassDistribution; off: ClassDistribution };
  readonly cosineCut?: FeatureCut;
  readonly rareShareCut?: FeatureCut;
  readonly marginCut?: FeatureCut;
  readonly combined?: CombinedCut;
  readonly separation?: "need both on and off";
}

interface ScoredQuestion {
  readonly cosine: number;
  readonly rareShare: number;
  readonly margin: number;
  readonly expect: Expectation;
}

function text(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function databasePath(env: NodeJS.ProcessEnv): string {
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  return path;
}

function areas(env: NodeJS.ProcessEnv): string[] {
  const list = (env.CONTEXT_AREAS ?? "personal").split(",");
  if (list.length > 8 || new Set(list).size !== list.length)
    throw new Error("Invalid configured areas");
  try {
    for (const area of list) scopeSchema.parse(area);
  } catch {
    throw new Error("Invalid configured areas");
  }
  return list;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

function formatList(values: readonly string[]): string {
  return values.length ? values.join(", ") : "-";
}

function formatCut(cut: number | null): string {
  return cut === null ? "> 1" : `>= ${formatNumber(cut)}`;
}

function formatScore(score: ClassScore): string {
  return `on ${score.onCorrect}/${score.onTotal} off ${score.offCorrect}/${score.offTotal}`;
}

export function formatExplain(row: ExplainRow): string {
  const frequency = row.documentFrequency
    .map((term) => `${term.term}=${term.df}${term.common ? " common" : ""}`)
    .join(", ");
  const thresholds = row.thresholds;
  const lines = [
    `query: ${row.query}`,
    `area: ${row.area}`,
    ...(row.project ? [`project: ${row.project}`] : []),
    ...(row.expect ? [`expect: ${row.expect}`] : []),
    `grounding: ${row.grounding}`,
    `cosine: ${formatNumber(row.cosine)}`,
    `background: ${formatNumber(row.background)}`,
    `margin: ${formatNumber(row.margin)}`,
    `rareShare: ${formatNumber(row.rareShare)}`,
    `matchedRare: ${formatList(row.matchedRare)}`,
    `commonDropped: ${formatList(row.commonDropped)}`,
    `corpus: ${row.corpus}`,
    `documentFrequency: ${frequency || "-"}`,
    `thresholds: lexicalStrong=${formatNumber(thresholds.lexicalStrong)} lexicalOnlyStrong=${formatNumber(thresholds.lexicalOnlyStrong)} marginWeak=${formatNumber(thresholds.marginWeak)} marginStrong=${formatNumber(thresholds.marginStrong)} commonCorpus=${thresholds.commonCorpus} commonMinDf=${thresholds.commonMinDf} commonRate=${formatNumber(thresholds.commonRate)}`,
    `vectors: ${row.vectors}`,
    `topHit: ${row.topHit ? `${row.topHit.id}${row.topHit.title ? ` ${row.topHit.title}` : ""}` : "-"}`,
  ];
  return lines.join("\n");
}

function distribution(values: readonly number[]): ClassDistribution {
  if (!values.length) return { n: 0, min: null, p50: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: sorted[Math.floor((sorted.length - 1) / 2)] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  };
}

function objective(score: ClassScore): number {
  if (score.onTotal === 0 || score.offTotal === 0) return -1;
  return score.onCorrect / score.onTotal + score.offCorrect / score.offTotal;
}

function tally(
  rows: readonly ScoredQuestion[],
  predictOn: readonly boolean[],
): ClassScore {
  let onCorrect = 0;
  let onTotal = 0;
  let offCorrect = 0;
  let offTotal = 0;
  for (const [index, row] of rows.entries()) {
    const on = predictOn[index] === true;
    if (row.expect === "on") {
      onTotal += 1;
      if (on) onCorrect += 1;
    } else {
      offTotal += 1;
      if (!on) offCorrect += 1;
    }
  }
  return { onCorrect, onTotal, offCorrect, offTotal };
}

function passes(value: number, cut: number | null): boolean {
  return cut !== null && value >= cut - 1e-12;
}

function candidateCuts(values: readonly number[]): Array<number | null> {
  const finite = [
    ...new Set(values.filter((value) => value >= -1 && value <= 1)),
    0,
  ].sort((a, b) => a - b);
  return [...finite, null];
}

function offRate(score: ClassScore): number {
  return score.offTotal === 0 ? 0 : score.offCorrect / score.offTotal;
}

function cutHeight(cut: number | null): number {
  return cut === null ? Number.POSITIVE_INFINITY : cut;
}

function betterScore(
  next: ClassScore,
  nextRank: number,
  current: ClassScore,
  currentRank: number,
): boolean {
  const gain = objective(next) - objective(current);
  if (gain > 1e-12) return true;
  if (gain < -1e-12) return false;
  const off = offRate(next) - offRate(current);
  if (off > 1e-12) return true;
  if (off < -1e-12) return false;
  return nextRank > currentRank;
}

function bestFeatureCut(
  rows: readonly ScoredQuestion[],
  feature: "cosine" | "rareShare" | "margin",
): FeatureCut {
  let best: FeatureCut = {
    cut: 0,
    ...tally(
      rows,
      rows.map(() => true),
    ),
  };
  for (const cut of candidateCuts(rows.map((row) => row[feature]))) {
    const score = tally(
      rows,
      rows.map((row) => passes(row[feature], cut)),
    );
    if (betterScore(score, cutHeight(cut), best, cutHeight(best.cut)))
      best = { cut, ...score };
  }
  return best;
}

function bestCombined(rows: readonly ScoredQuestion[]): CombinedCut {
  const rareCuts = candidateCuts(rows.map((row) => row.rareShare));
  const marginCuts = candidateCuts(rows.map((row) => row.margin));
  let best: CombinedCut = {
    op: "and",
    rareShare: 0,
    margin: 0,
    ...tally(
      rows,
      rows.map(() => true),
    ),
  };
  for (const op of ["and", "or"] as const) {
    for (const rareShare of rareCuts) {
      for (const margin of marginCuts) {
        const score = tally(
          rows,
          rows.map((row) => {
            const rare = passes(row.rareShare, rareShare);
            const near = passes(row.margin, margin);
            return op === "and" ? rare && near : rare || near;
          }),
        );
        const rank =
          cutHeight(rareShare) * 8 +
          cutHeight(margin) +
          (op === "and" ? 0.5 : 0);
        const current =
          cutHeight(best.rareShare) * 8 +
          cutHeight(best.margin) +
          (best.op === "and" ? 0.5 : 0);
        if (betterScore(score, rank, best, current))
          best = { op, rareShare, margin, ...score };
      }
    }
  }
  return best;
}

/** On/off distributions and the cuts that separate them. */
export function calibrateSeparation(
  rows: readonly ScoredQuestion[],
): SeparationSummary {
  const on = rows.filter((row) => row.expect === "on");
  const off = rows.filter((row) => row.expect === "off");
  const summary: SeparationSummary = {
    cosine: {
      on: distribution(on.map((row) => row.cosine)),
      off: distribution(off.map((row) => row.cosine)),
    },
    rareShare: {
      on: distribution(on.map((row) => row.rareShare)),
      off: distribution(off.map((row) => row.rareShare)),
    },
    margin: {
      on: distribution(on.map((row) => row.margin)),
      off: distribution(off.map((row) => row.margin)),
    },
  };
  if (!on.length || !off.length)
    return { ...summary, separation: "need both on and off" };
  return {
    ...summary,
    cosineCut: bestFeatureCut(rows, "cosine"),
    rareShareCut: bestFeatureCut(rows, "rareShare"),
    marginCut: bestFeatureCut(rows, "margin"),
    combined: bestCombined(rows),
  };
}

export function formatSeparation(summary: SeparationSummary): string {
  const band = (name: string, stats: ClassDistribution) =>
    stats.n === 0
      ? `  ${name}: n=0`
      : `  ${name}: n=${stats.n} min=${formatNumber(stats.min ?? 0)} p50=${formatNumber(stats.p50 ?? 0)} max=${formatNumber(stats.max ?? 0)}`;
  const lines = [
    "summary:",
    band("cosine on", summary.cosine.on),
    band("cosine off", summary.cosine.off),
    band("rareShare on", summary.rareShare.on),
    band("rareShare off", summary.rareShare.off),
    band("margin on", summary.margin.on),
    band("margin off", summary.margin.off),
  ];
  if (summary.separation) {
    lines.push(`  separation: ${summary.separation}`);
    return lines.join("\n");
  }
  if (summary.cosineCut)
    lines.push(
      `  cosine cut ${formatCut(summary.cosineCut.cut)}: ${formatScore(summary.cosineCut)}`,
    );
  if (summary.rareShareCut)
    lines.push(
      `  rareShare cut ${formatCut(summary.rareShareCut.cut)}: ${formatScore(summary.rareShareCut)}`,
    );
  if (summary.marginCut)
    lines.push(
      `  margin cut ${formatCut(summary.marginCut.cut)}: ${formatScore(summary.marginCut)}`,
    );
  if (summary.combined)
    lines.push(
      `  combined: rareShare ${formatCut(summary.combined.rareShare)} ${summary.combined.op} margin ${formatCut(summary.combined.margin)}: ${formatScore(summary.combined)}`,
    );
  return lines.join("\n");
}

function rowFromReport(
  query: string,
  area: string,
  project: string | undefined,
  expect: Expectation | undefined,
  pack: ReturnType<typeof buildContextPackage>,
): ExplainRow {
  const report = searchGroundingReport(pack);
  if (!report || report.label !== pack.grounding)
    throw new Error("Grounding report missing");
  return {
    query,
    area,
    ...(project ? { project } : {}),
    ...(expect ? { expect } : {}),
    grounding: report.label,
    cosine: report.cosine,
    background: report.background,
    margin: report.margin,
    rareShare: report.rareShare,
    matchedRare: report.matchedRare,
    commonDropped: report.commonDropped,
    corpus: report.documents,
    documentFrequency: report.documentFrequency,
    thresholds: report.thresholds,
    vectors: report.vectorsAvailable,
    topHit: searchTopHit(pack) ?? null,
  };
}

async function explainRows(
  env: NodeJS.ProcessEnv,
  area: string,
  questions: readonly {
    query: string;
    project?: string;
    expect?: Expectation;
  }[],
): Promise<ExplainRow[]> {
  const path = databasePath(env);
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  let index: EmbeddingIndex | undefined;
  try {
    const projects = new Set(
      questions.flatMap((question) =>
        question.project ? [question.project] : [],
      ),
    );
    for (const project of projects) {
      if (!sources.hasProject(project))
        throw new Error(`Unknown project: ${project}`);
    }
    index = new EmbeddingIndex(path, localEmbedder(), { readOnly: true });
    let embeddings: EmbeddingIndex | undefined;
    if (index.hasVectors(area)) {
      try {
        await index.load();
        embeddings = index;
      } catch {
        process.stderr.write(
          "embeddings unavailable; cosine is lexical-only\n",
        );
      }
    }
    const rows: ExplainRow[] = [];
    for (const question of questions) {
      let semantic: Awaited<ReturnType<EmbeddingIndex["search"]>> | undefined;
      if (embeddings) {
        semantic = await embeddings.search({
          scope: area,
          question: question.query,
          ...(question.project ? { projectId: question.project } : {}),
        });
      }
      let pack: ReturnType<typeof buildContextPackage>;
      try {
        pack = buildContextPackage(
          sources,
          knowledge,
          { version: 1, scope: area, question: question.query, limit: 8 },
          semantic,
          question.project,
        );
      } catch (error) {
        if (error instanceof ZodError) throw new Error("Invalid query");
        throw error;
      }
      rows.push(
        rowFromReport(
          question.query,
          area,
          question.project,
          question.expect,
          pack,
        ),
      );
    }
    return rows;
  } finally {
    await index?.close();
    knowledge.close();
    sources.close();
  }
}

async function readQuestions(path: string) {
  const raw = await readFile(path);
  if (raw.byteLength > 256 * 1024)
    throw new Error("Questions file is too large");
  let parsed: unknown;
  try {
    parsed = parseDocument(raw.toString("utf8"), { uniqueKeys: true }).toJS({
      maxAliasCount: 0,
    });
  } catch {
    throw new Error(usage);
  }
  const questions = z.array(questionSchema).min(1).max(100).safeParse(parsed);
  if (!questions.success) throw new Error(usage);
  return questions.data;
}

export async function groundingCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "explain") throw new Error(usage);
  let query: string | undefined;
  let file: string | undefined;
  let areaArg: string | undefined;
  let project: string | undefined;
  let json = false;
  try {
    const parsed = parseArgs({
      args: rest,
      options: {
        query: { type: "string" },
        file: { type: "string" },
        area: { type: "string" },
        project: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
    query = text(parsed.query);
    file = text(parsed.file);
    areaArg = text(parsed.area);
    project = text(parsed.project);
    json = parsed.json === true;
  } catch {
    throw new Error(usage);
  }
  if (Boolean(query) === Boolean(file)) throw new Error(usage);
  const configured = areas(env);
  const area = areaArg ?? configured[0];
  if (!area || !configured.includes(area)) throw new Error("Unknown area");
  if (project && !projectIdSchema.safeParse(project).success)
    throw new Error(usage);
  const chosen = (value: string | undefined) =>
    value ? { project: value } : {};
  const questions = file
    ? (await readQuestions(file)).map((question) => ({
        query: question.query,
        ...chosen(question.project ?? project),
        expect: question.expect,
      }))
    : [{ query: query ?? "", ...chosen(project) }];
  const rows = await explainRows(env, area, questions);
  if (file) {
    const summary = calibrateSeparation(
      rows.flatMap((row) =>
        row.expect
          ? [
              {
                cosine: row.cosine,
                rareShare: row.rareShare,
                margin: row.margin,
                expect: row.expect,
              },
            ]
          : [],
      ),
    );
    process.stdout.write(
      json
        ? `${JSON.stringify({ queries: rows, summary })}\n`
        : `${rows.map((row) => formatExplain(row)).join("\n\n")}\n\n${formatSeparation(summary)}\n`,
    );
    return;
  }
  const row = rows[0];
  if (!row) throw new Error(usage);
  process.stdout.write(`${json ? JSON.stringify(row) : formatExplain(row)}\n`);
}
