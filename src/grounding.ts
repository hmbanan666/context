import { phraseWords, stemsMatch } from "./glossary.js";
import { textChunks } from "./embedding-model.js";
import { stemText } from "./search-lexical.js";

// Absolute evidence for whether anything relevant exists. Rank is not an input.
// A nearest neighbour can still be grounding "none".
//
// Terms count only when they co-occur in one passage. A passage is the same
// chunk the embedding index stores (256 UTF-16 code units, 64 overlap), so a
// score belongs to the window that actually matched. Glossary synonyms do
// not count; they expand the query, they are not the caller's words.
//
// Each term is weighted by inverse document frequency in the same pool search
// can match. Common terms stay in the denominator and cannot by themselves
// reach strong. On a small corpus nothing is common, so a specific note still
// grounds. A project's id, name, and glossary terms are never common.
//
// With embeddings, strong also needs a margin: the evidence cosine minus the
// cosine of the query to the cached area or project centroid. An absolute
// cosine does not separate compressed E5 scores. With no vectors, the lexical
// bar is stricter and the margin is not used. A passage that matches only
// common terms is not lexical evidence: if no passage matches a rare term and
// the margin is below the weak floor, the result is none. The margin still
// applies when no passage contains a query term.

export type Grounding = "strong" | "weak" | "none";

export interface GroundingThresholds {
  /** Uncommon IDF share that counts as strong when embeddings exist. */
  readonly lexicalStrong: number;
  /** Stricter uncommon IDF share when no embeddings are available. */
  readonly lexicalOnlyStrong: number;
  /** Margin that counts as weak when the query terms themselves do not match. */
  readonly marginWeak: number;
  /** Margin that counts as strong. Also required of a rare-term passage. */
  readonly marginStrong: number;
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
  // Public fixture, multilingual-e5-small. Curated on-topic margin was
  // 0.014–0.081 (median 0.032) and off-topic margin was negative. On the mixed
  // corpus, off-topic margin reached 0.109 while absolute cosine reached 0.928.
  // Calibrate on a real database with `context grounding explain --file`.
  marginWeak: 0.03,
  marginStrong: 0.08,
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
  const marginWeak = readUnit(
    env.CONTEXT_GROUNDING_MARGIN_WEAK,
    defaultGroundingThresholds.marginWeak,
    "CONTEXT_GROUNDING_MARGIN_WEAK",
  );
  const marginStrong = readUnit(
    env.CONTEXT_GROUNDING_MARGIN_STRONG,
    defaultGroundingThresholds.marginStrong,
    "CONTEXT_GROUNDING_MARGIN_STRONG",
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
  if (marginStrong < marginWeak)
    throw new Error("Invalid CONTEXT_GROUNDING_MARGIN_STRONG");
  if (commonRate <= 0) throw new Error("Invalid CONTEXT_GROUNDING_COMMON_RATE");
  return {
    lexicalStrong,
    lexicalOnlyStrong,
    marginWeak,
    marginStrong,
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

function identityStems(words: readonly string[]): string[] {
  const stems: string[] = [];
  for (const word of words) {
    for (const piece of phraseWords(word)) {
      const stem = stemText(piece);
      if (stem) stems.push(stem);
    }
  }
  return stems;
}

function isIdentity(stem: string, identity: readonly string[]): boolean {
  return identity.some((item) => stemsMatch(item, stem));
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

export interface GroundingTermFrequency {
  readonly term: string;
  readonly df: number;
  readonly common: boolean;
}

/** Features behind one grounding label. Rank is not an input. */
export interface GroundingReport {
  readonly label: Grounding;
  /** Highest cosine on a passage window, or the unmatched hit when higher. */
  readonly cosine: number;
  /** Cosine of the query to the cached area or project centroid. */
  readonly background: number;
  /**
   * Evidence cosine minus `background`. Evidence cosine is the best passage
   * when no rare term matched, and the rare-term window otherwise.
   */
  readonly margin: number;
  /** Uncommon IDF share of the best passage window. */
  readonly rareShare: number;
  /** Rare query terms that occur in at least one passage. */
  readonly matchedRare: readonly string[];
  /** Query terms classified as common and left out of the rare numerator. */
  readonly commonDropped: readonly string[];
  readonly documents: number;
  readonly documentFrequency: readonly GroundingTermFrequency[];
  readonly thresholds: GroundingThresholds;
  readonly vectorsAvailable: boolean;
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
  identity: readonly string[],
): {
  readonly anyMatch: boolean;
  readonly anyRare: boolean;
  readonly best: WindowScore;
  readonly bestCosine: number;
  readonly matchedRare: readonly string[];
  readonly commonDropped: readonly string[];
  readonly terms: readonly GroundingTermFrequency[];
} {
  const info = terms.map((term) => {
    const df = documentFrequency.get(term) ?? 0;
    const stem = stemText(term);
    const common =
      !isIdentity(stem, identity) && termIsCommon(df, documents, thresholds);
    return {
      term,
      stem,
      weight: termWeight(df, documents),
      common,
      df,
    };
  });
  const totalWeight = info.reduce((sum, term) => sum + term.weight, 0);
  let best: WindowScore = { uncommon: 0, coverage: 0, matched: 0, cosine: 0 };
  let anyMatch = false;
  let bestCosine = 0;
  const rareHits = new Set<string>();
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
        rareHits.add(term.term);
      }
      if (matched > 0) anyMatch = true;
      const cosine = cosineAt(passage.vectors, chunk.offset);
      if (cosine > bestCosine) bestCosine = cosine;
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
        cosine,
      };
      if (better(score, best)) best = score;
    }
  }
  return {
    anyMatch,
    anyRare: rareHits.size > 0,
    best,
    bestCosine,
    matchedRare: info
      .filter((term) => rareHits.has(term.term))
      .map((term) => term.term),
    commonDropped: info.filter((term) => term.common).map((term) => term.term),
    terms: info.map((term) => ({
      term: term.term,
      df: term.df,
      common: term.common,
    })),
  };
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

function unitCosine(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

/** Grounding from passage windows, with the features that produced the label. */
export function explainStoredGrounding(input: {
  readonly terms: readonly string[];
  readonly passages: readonly GroundingPassage[];
  readonly documents: number;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly vectorsAvailable: boolean;
  readonly unmatchedCosine?: number;
  /** Cosine of the query to the cached centroid. Used only when vectors exist. */
  readonly backgroundCosine?: number;
  /** Project id, name, and glossary terms. Never classified as common. */
  readonly protectedTerms?: readonly string[];
  readonly thresholds?: GroundingThresholds;
}): GroundingReport {
  const thresholds = input.thresholds ?? readGroundingThresholds(process.env);
  const scored = scorePassages(
    input.passages,
    input.terms,
    input.documentFrequency,
    input.documents,
    thresholds,
    identityStems(input.protectedTerms ?? []),
  );
  const cosine = Math.max(scored.bestCosine, input.unmatchedCosine ?? 0);
  const background = input.vectorsAvailable
    ? unitCosine(input.backgroundCosine)
    : 0;
  const evidenceCosine = scored.anyRare ? scored.best.cosine : cosine;
  const margin = input.vectorsAvailable ? evidenceCosine - background : 0;
  let label: Grounding;
  if (!input.vectorsAvailable) {
    label =
      scored.anyRare && scored.best.uncommon >= thresholds.lexicalOnlyStrong
        ? "strong"
        : scored.anyRare
          ? "weak"
          : "none";
  } else if (!scored.anyRare) {
    // Common terms alone never reach strong. A low margin is none.
    if (margin < thresholds.marginWeak) label = "none";
    else if (!scored.anyMatch && margin >= thresholds.marginStrong)
      label = "strong";
    else label = "weak";
  } else {
    label =
      scored.best.uncommon >= thresholds.lexicalStrong &&
      margin >= thresholds.marginStrong
        ? "strong"
        : "weak";
  }
  return {
    label,
    cosine,
    background,
    margin,
    rareShare: scored.best.uncommon,
    matchedRare: scored.matchedRare,
    commonDropped: scored.commonDropped,
    documents: Math.max(0, input.documents),
    documentFrequency: scored.terms,
    thresholds,
    vectorsAvailable: input.vectorsAvailable,
  };
}

/** Grounding from passage windows. Rank is not an input. */
export function assessStoredGrounding(
  input: Parameters<typeof explainStoredGrounding>[0],
): Grounding {
  return explainStoredGrounding(input).label;
}
