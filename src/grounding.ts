import { textChunks } from "./embedding-model.js";
import { stemText } from "./search-lexical.js";

// Absolute evidence for whether anything relevant exists. Rank is not an input.
// A nearest neighbour can still be grounding "none".
//
// Terms count only when they co-occur in one passage. A passage is the same
// chunk the embedding index stores (256 UTF-16 code units, 64 overlap), so a
// cosine belongs to the window that actually matched. Glossary synonyms do
// not count; they expand the query, they are not the caller's words.
//
// Each term is weighted by inverse document frequency in the searched sources.
// Common terms stay in the denominator and cannot by themselves reach strong.
// On a small corpus nothing is common, so a specific note still grounds.
//
// With embeddings, strong also needs the matched passage's cosine. With no
// vectors, the lexical bar is stricter. Semantic cosine still applies when no
// passage contains a query term.

export type Grounding = "strong" | "weak" | "none";

export interface GroundingThresholds {
  /** Uncommon IDF share that counts as strong when embeddings exist. */
  readonly lexicalStrong: number;
  /** Stricter uncommon IDF share when no embeddings are available. */
  readonly lexicalOnlyStrong: number;
  /** Cosine that counts as weak when the query terms themselves do not match. */
  readonly cosineWeak: number;
  /** Cosine that counts as strong. Also required of the matched passage. */
  readonly cosineStrong: number;
  /** Minimum corpus size before a term can be common. */
  readonly commonCorpus: number;
  /** Minimum document frequency before a term can be common. */
  readonly commonMinDf: number;
  /** Minimum share of the corpus before a term can be common. */
  readonly commonRate: number;
}

export const defaultGroundingThresholds: GroundingThresholds = {
  lexicalStrong: 0.5,
  lexicalOnlyStrong: 0.75,
  // Fixture measurement on multilingual-e5-small: off-topic neighbours stayed
  // under the 0.80 retrieval floor, and on-topic cosine was at least 0.853.
  cosineWeak: 0.84,
  cosineStrong: 0.92,
  commonCorpus: 40,
  commonMinDf: 8,
  commonRate: 0.05,
};

export interface GroundingVector {
  readonly offset: number;
  readonly score: number;
}

export interface GroundingPassage {
  readonly text: string;
  readonly vectors?: readonly GroundingVector[];
}

function readUnit(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`Invalid ${name}`);
  return value;
}

function readCount(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000)
    throw new Error(`Invalid ${name}`);
  return value;
}

export function readGroundingThresholds(
  env: NodeJS.ProcessEnv,
): GroundingThresholds {
  const lexicalStrong = readUnit(
    env.CONTEXT_GROUNDING_LEXICAL_STRONG,
    defaultGroundingThresholds.lexicalStrong,
    "CONTEXT_GROUNDING_LEXICAL_STRONG",
  );
  const lexicalOnlyStrong = readUnit(
    env.CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG,
    defaultGroundingThresholds.lexicalOnlyStrong,
    "CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG",
  );
  const cosineWeak = readUnit(
    env.CONTEXT_GROUNDING_COSINE_WEAK,
    defaultGroundingThresholds.cosineWeak,
    "CONTEXT_GROUNDING_COSINE_WEAK",
  );
  const cosineStrong = readUnit(
    env.CONTEXT_GROUNDING_COSINE_STRONG,
    defaultGroundingThresholds.cosineStrong,
    "CONTEXT_GROUNDING_COSINE_STRONG",
  );
  const commonCorpus = readCount(
    env.CONTEXT_GROUNDING_COMMON_CORPUS,
    defaultGroundingThresholds.commonCorpus,
    "CONTEXT_GROUNDING_COMMON_CORPUS",
  );
  const commonMinDf = readCount(
    env.CONTEXT_GROUNDING_COMMON_MIN_DF,
    defaultGroundingThresholds.commonMinDf,
    "CONTEXT_GROUNDING_COMMON_MIN_DF",
  );
  const commonRate = readUnit(
    env.CONTEXT_GROUNDING_COMMON_RATE,
    defaultGroundingThresholds.commonRate,
    "CONTEXT_GROUNDING_COMMON_RATE",
  );
  if (lexicalOnlyStrong < lexicalStrong)
    throw new Error("Invalid CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG");
  if (cosineStrong < cosineWeak)
    throw new Error("Invalid CONTEXT_GROUNDING_COSINE_STRONG");
  if (commonRate <= 0) throw new Error("Invalid CONTEXT_GROUNDING_COMMON_RATE");
  return {
    lexicalStrong,
    lexicalOnlyStrong,
    cosineWeak,
    cosineStrong,
    commonCorpus,
    commonMinDf,
    commonRate,
  };
}

export function termWeight(df: number, documents: number): number {
  const total = Math.max(0, documents);
  const seen = Math.min(Math.max(0, df), total);
  return Math.log((total + 1) / (seen + 1));
}

function termIsCommon(
  df: number,
  documents: number,
  thresholds: GroundingThresholds,
): boolean {
  return (
    documents >= thresholds.commonCorpus &&
    df >= thresholds.commonMinDf &&
    documents > 0 &&
    df / documents >= thresholds.commonRate
  );
}

function stemsOf(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) =>
      stemText(word),
    ),
  );
}

function cosineAt(
  vectors: readonly GroundingVector[] | undefined,
  offset: number,
): number {
  let best = 0;
  for (const hit of vectors ?? []) {
    if (
      hit.offset !== offset ||
      !Number.isFinite(hit.score) ||
      hit.score <= best
    )
      continue;
    best = hit.score;
  }
  return best;
}

interface WindowScore {
  readonly uncommon: number;
  readonly coverage: number;
  readonly matched: number;
  readonly cosine: number;
}

function better(candidate: WindowScore, current: WindowScore): boolean {
  if (candidate.uncommon !== current.uncommon)
    return candidate.uncommon > current.uncommon;
  if (candidate.cosine !== current.cosine)
    return candidate.cosine > current.cosine;
  if (candidate.matched !== current.matched)
    return candidate.matched > current.matched;
  return candidate.coverage > current.coverage;
}

function scorePassages(
  passages: readonly GroundingPassage[],
  terms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documents: number,
  thresholds: GroundingThresholds,
): { readonly anyMatch: boolean; readonly best: WindowScore } {
  const info = terms.map((term) => {
    const df = documentFrequency.get(term) ?? 0;
    return {
      stem: stemText(term),
      weight: termWeight(df, documents),
      common: termIsCommon(df, documents, thresholds),
    };
  });
  const totalWeight = info.reduce((sum, term) => sum + term.weight, 0);
  let best: WindowScore = { uncommon: 0, coverage: 0, matched: 0, cosine: 0 };
  let anyMatch = false;
  for (const passage of passages) {
    for (const chunk of textChunks(passage.text)) {
      const stems = stemsOf(chunk.text);
      let matchedWeight = 0;
      let uncommonWeight = 0;
      let matched = 0;
      let uncommonMatched = 0;
      for (const term of info) {
        if (!stems.has(term.stem)) continue;
        matched += 1;
        matchedWeight += term.weight;
        if (term.common) continue;
        uncommonWeight += term.weight;
        uncommonMatched += 1;
      }
      if (matched > 0) anyMatch = true;
      const score: WindowScore = {
        uncommon:
          totalWeight > 0
            ? uncommonWeight / totalWeight
            : terms.length > 0
              ? uncommonMatched / terms.length
              : 0,
        coverage:
          totalWeight > 0
            ? matchedWeight / totalWeight
            : terms.length > 0
              ? matched / terms.length
              : 0,
        matched,
        cosine: cosineAt(passage.vectors, chunk.offset),
      };
      if (better(score, best)) best = score;
    }
  }
  return { anyMatch, best };
}

export function groundingVectors(
  hits:
    | readonly {
        readonly id: string;
        readonly offset: number;
        readonly score?: number;
      }[]
    | undefined,
  id: string,
): GroundingVector[] {
  const vectors: GroundingVector[] = [];
  for (const hit of hits ?? []) {
    if (
      hit.id !== id ||
      typeof hit.score !== "number" ||
      !Number.isFinite(hit.score)
    )
      continue;
    vectors.push({ offset: hit.offset, score: hit.score });
  }
  return vectors;
}

export function bestCosine(
  hits: readonly { readonly score?: number }[] | undefined,
): number {
  let best = 0;
  for (const hit of hits ?? []) {
    const score = hit.score;
    if (typeof score === "number" && Number.isFinite(score) && score > best)
      best = score;
  }
  return best;
}

/** Grounding from passage windows. Rank is not an input. */
export function assessStoredGrounding(input: {
  readonly terms: readonly string[];
  readonly passages: readonly GroundingPassage[];
  readonly documents: number;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly vectorsAvailable: boolean;
  readonly unmatchedCosine?: number;
  readonly thresholds?: GroundingThresholds;
}): Grounding {
  const thresholds = input.thresholds ?? readGroundingThresholds(process.env);
  const scored = scorePassages(
    input.passages,
    input.terms,
    input.documentFrequency,
    input.documents,
    thresholds,
  );
  if (scored.anyMatch) {
    const bar = input.vectorsAvailable
      ? thresholds.lexicalStrong
      : thresholds.lexicalOnlyStrong;
    if (
      scored.best.uncommon >= bar &&
      (!input.vectorsAvailable || scored.best.cosine >= thresholds.cosineStrong)
    )
      return "strong";
    return "weak";
  }
  const cosine = input.unmatchedCosine ?? 0;
  if (cosine >= thresholds.cosineStrong) return "strong";
  if (cosine >= thresholds.cosineWeak) return "weak";
  return "none";
}
