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
// Question words and other function words are not content terms: they stay
// out of the share numerator and the denominator. A heading is scored with
// the first window only and does not move the chunk offsets used for vectors.
//
// Each term is weighted by inverse document frequency in the same pool search
// can match. Common terms stay in the denominator and cannot by themselves
// reach strong. On a small corpus nothing is common, so a specific note still
// grounds. A project's id, name, and glossary terms are never common.
//
// With embeddings, strong also needs a margin: the evidence cosine minus the
// cosine of the query to the cached area or project centroid. An absolute
// cosine does not separate compressed E5 scores. The result is none when the
// uncommon share is below the lexical-none floor and the margin is below the
// weak floor, even if some rare term matched. Otherwise a rare-term passage
// is weak or strong as before. With no vectors, the lexical bar is stricter
// and the margin is not used. The same share floor is none on that path too.
// A scoped corpus smaller than marginMinCorpus (default 6) skips the margin
// and uses that lexical path: the centroid is too close to the passage itself
// for the margin to mean anything, so an exact match can be strong.
// A passage that matches only common terms is not lexical evidence. The
// margin still applies when no passage contains a query term.
//
// Search only returns vector hits at cosine >= 0.80, and at most 20 records,
// so the passage that carried the rare term can have no hit. Its stored chunk
// vector is then dotted with the query (see SemanticHits.storedCosines).
// That cosine is `vector`. A chunk with no stored vector for this model stays
// cosine 0 and `missing`; it is not embedded again. The rendered profile
// section in a task pack has no chunk row, so it stays `missing` too.

export type Grounding = "strong" | "weak" | "none";

/** Where the evidence cosine came from. `missing` counts as cosine 0. */
export type CosineSource = "vector" | "missing";

/** Which labelling rule produced the grounding label. */
export type GroundingRule =
  | "none-low-share-low-margin"
  | "none-low-margin"
  | "strong-margin-only"
  | "weak-margin"
  | "strong-rare-margin"
  | "weak-rare"
  | "none-lexical-share"
  | "strong-lexical"
  | "weak-lexical"
  | "none-lexical";

export interface GroundingThresholds {
  /** Uncommon IDF share that counts as strong when embeddings exist. */
  readonly lexicalStrong: number;
  /**
   * Uncommon IDF share below which a low margin is `none`, even when a rare
   * term matched. The lexical-only path uses the same floor with no margin.
   */
  readonly lexicalNone: number;
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
  /**
   * Use the centroid margin only when the scoped corpus has at least this
   * many records. Below it, lexical-only rules apply.
   */
  readonly marginMinCorpus: number;
}

export const defaultGroundingThresholds: GroundingThresholds = {
  lexicalStrong: 0.5,
  lexicalNone: 0.3,
  lexicalOnlyStrong: 0.75,
  // Public fixture, multilingual-e5-small. Curated on-topic margin was
  // 0.014–0.081 (median 0.032) and off-topic margin was negative. On the mixed
  // corpus, off-topic margin reached 0.109 while absolute cosine reached 0.928.
  // A later calibration separates classes with margin >= 0.024 or rare share
  // >= 0.30. 0.024 is the default only while the public curated and mixed
  // evals, lexical and semantic, stay green.
  // Calibrate on a real database with `context grounding explain --file`.
  marginWeak: 0.024,
  marginStrong: 0.08,
  commonCorpus: 40,
  commonMinDf: 8,
  commonRate: 0.05,
  // Public margin tests use 7 passages and must keep the margin path.
  // Three similar notes make the centroid almost the passage, so the margin
  // stays near 0 and an exact hit cannot reach strong.
  marginMinCorpus: 6,
};

export interface GroundingVector {
  readonly offset: number;
  readonly score: number;
}

export interface GroundingPassage {
  readonly text: string;
  /** Stored title. Lexical evidence for the first window only. */
  readonly heading?: string;
  readonly vectors?: readonly GroundingVector[];
}

// Function words are not evidence and must not dilute a short question.
// Surfaces, not stems: чём and чем are both listed. A one-letter token is
// the same kind of noise (the s in "bot's").
const shareStops = new Set(
  `a an the what which who whom whose why how where when did does do
   was were is are am be been being of in on at to for and or but if
   than then so as my me you your yours we our ours us they them their
   it its this that these those there here with from by into onto about
   over under can could would should will shall may might must has have
   had not no nor please tell explain describe happened suitable
   work works working worked нет нету
   что какие какой какая какое какую каких каким какими
   как почему кто где когда куда откуда зачем
   это этот эта эти эту этого этой этом этих этим
   у я мои моих меня мой моя моё мое мне ты вы мы он она оно они
   в во на для и или о об обо по из с со к ко от ото до при над под подо
   без про через между чём чем чего чему ли же бы
   его её ее их им ей ему них неё нее то
   можно нужно надо такой такая такое такие
   весь вся всё все всего всей
   происходило подходит подходят известно не ни`
    .split(/\s+/u)
    .filter((word) => word.length > 0),
);

export function isShareStop(term: string): boolean {
  const word = term.toLowerCase();
  if (shareStops.has(word)) return true;
  return word.length === 1 && /\p{L}/u.test(word);
}

/** Title text that is not already the start of the indexed body. */
export function groundingHeading(
  title: string | undefined,
  text: string,
): string | undefined {
  const heading = title?.trim();
  if (!heading) return undefined;
  const body = text.trimStart();
  if (body.toLowerCase().startsWith(heading.toLowerCase())) {
    const next = body[heading.length];
    if (next === undefined || !/[\p{L}\p{N}]/u.test(next)) return undefined;
  }
  return heading;
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
  const lexicalNone = readUnit(
    env.CONTEXT_GROUNDING_LEXICAL_NONE,
    defaultGroundingThresholds.lexicalNone,
    "CONTEXT_GROUNDING_LEXICAL_NONE",
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
  const marginMinCorpus = readCount(
    env.CONTEXT_GROUNDING_MARGIN_MIN_CORPUS,
    defaultGroundingThresholds.marginMinCorpus,
    "CONTEXT_GROUNDING_MARGIN_MIN_CORPUS",
  );
  if (lexicalOnlyStrong < lexicalStrong)
    throw new Error("Invalid CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG");
  if (marginStrong < marginWeak)
    throw new Error("Invalid CONTEXT_GROUNDING_MARGIN_STRONG");
  if (commonRate <= 0) throw new Error("Invalid CONTEXT_GROUNDING_COMMON_RATE");
  return {
    lexicalStrong,
    lexicalNone,
    lexicalOnlyStrong,
    marginWeak,
    marginStrong,
    commonCorpus,
    commonMinDf,
    commonRate,
    marginMinCorpus,
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
): { cosine: number; source: CosineSource } {
  let best = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const hit of vectors ?? []) {
    if (hit.offset !== offset || !Number.isFinite(hit.score)) continue;
    found = true;
    if (hit.score > best) best = hit.score;
  }
  // No row at this offset. Callers may already have filled a stored cosine
  // below the retrieval floor; if they did not, the evidence cosine is 0.
  return found
    ? { cosine: best, source: "vector" }
    : { cosine: 0, source: "missing" };
}

interface WindowScore {
  readonly uncommon: number;
  readonly coverage: number;
  readonly matched: number;
  readonly cosine: number;
  readonly cosineSource: CosineSource;
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
  /** Labelling rule that produced `label`. */
  readonly rule: GroundingRule;
  /**
   * `vector` when the evidence cosine is a search hit or a stored chunk.
   * `missing` when that passage has no vector, so the cosine counts as 0.
   */
  readonly cosineSource: CosineSource;
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
  readonly sawVector: boolean;
  readonly matchedRare: readonly string[];
  readonly commonDropped: readonly string[];
  readonly terms: readonly GroundingTermFrequency[];
} {
  const contentTerms = terms.filter((term) => !isShareStop(term));
  const info = contentTerms.map((term) => {
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
  let best: WindowScore = {
    uncommon: 0,
    coverage: 0,
    matched: 0,
    cosine: 0,
    cosineSource: "missing",
  };
  let anyMatch = false;
  let bestCosine = Number.NEGATIVE_INFINITY;
  let sawVector = false;
  const rareHits = new Set<string>();
  for (const passage of passages) {
    for (const chunk of textChunks(passage.text)) {
      const window =
        chunk.offset === 0 && passage.heading
          ? `${passage.heading}\n${chunk.text}`
          : chunk.text;
      const stems = stemsOf(window);
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
      const looked = cosineAt(passage.vectors, chunk.offset);
      if (looked.source === "vector") {
        sawVector = true;
        if (looked.cosine > bestCosine) bestCosine = looked.cosine;
      }
      const score: WindowScore = {
        uncommon:
          totalWeight > 0
            ? uncommonWeight / totalWeight
            : contentTerms.length > 0
              ? uncommonMatched / contentTerms.length
              : 0,
        coverage:
          totalWeight > 0
            ? matchedWeight / totalWeight
            : contentTerms.length > 0
              ? matched / contentTerms.length
              : 0,
        matched,
        cosine: looked.cosine,
        cosineSource: looked.source,
      };
      if (better(score, best)) best = score;
    }
  }
  return {
    anyMatch,
    anyRare: rareHits.size > 0,
    best,
    bestCosine: sawVector ? bestCosine : 0,
    sawVector,
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

/** Search hits plus stored chunk cosines for the same record. */
export function passageVectors(
  id: string,
  hits:
    | readonly {
        readonly id: string;
        readonly offset: number;
        readonly score?: number;
      }[]
    | undefined,
  stored:
    | readonly {
        readonly id: string;
        readonly offset: number;
        readonly score?: number;
      }[]
    | undefined,
): GroundingVector[] {
  const vectors = groundingVectors(hits, id);
  for (const hit of stored ?? []) {
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

function labelLexical(
  scored: { anyRare: boolean; best: WindowScore },
  thresholds: GroundingThresholds,
): { label: Grounding; rule: GroundingRule } {
  // Same share floor as the embedding none rule. No margin on this path.
  if (scored.best.uncommon < thresholds.lexicalNone)
    return { label: "none", rule: "none-lexical-share" };
  if (scored.anyRare && scored.best.uncommon >= thresholds.lexicalOnlyStrong)
    return { label: "strong", rule: "strong-lexical" };
  if (scored.anyRare) return { label: "weak", rule: "weak-lexical" };
  return { label: "none", rule: "none-lexical" };
}

function labelWithVectors(
  scored: { anyMatch: boolean; anyRare: boolean; best: WindowScore },
  margin: number,
  thresholds: GroundingThresholds,
): { label: Grounding; rule: GroundingRule } {
  // A rare term can match and still be none when it is only a small share
  // of the query and the passage sits below the weak margin.
  if (
    scored.best.uncommon < thresholds.lexicalNone &&
    margin < thresholds.marginWeak
  )
    return { label: "none", rule: "none-low-share-low-margin" };
  if (!scored.anyRare) {
    // lexicalNone 0 disables the share floor; a low margin is still none.
    if (margin < thresholds.marginWeak)
      return { label: "none", rule: "none-low-margin" };
    if (!scored.anyMatch && margin >= thresholds.marginStrong)
      return { label: "strong", rule: "strong-margin-only" };
    return { label: "weak", rule: "weak-margin" };
  }
  if (
    scored.best.uncommon >= thresholds.lexicalStrong &&
    margin >= thresholds.marginStrong
  )
    return { label: "strong", rule: "strong-rare-margin" };
  return { label: "weak", rule: "weak-rare" };
}

function evidenceSource(
  anyRare: boolean,
  best: WindowScore,
  bestCosine: number,
  sawVector: boolean,
  unmatched: number | undefined,
): CosineSource {
  if (anyRare) return best.cosineSource;
  const other = unmatched ?? 0;
  if (sawVector && bestCosine >= other) return "vector";
  if (other > 0) return "vector";
  return "missing";
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
  const documents = Math.max(0, input.documents);
  const scored = scorePassages(
    input.passages,
    input.terms,
    input.documentFrequency,
    documents,
    thresholds,
    identityStems(input.protectedTerms ?? []),
  );
  const cosine = Math.max(scored.bestCosine, input.unmatchedCosine ?? 0);
  // Few passages: the centroid is nearly the passage, so the margin cannot
  // separate an exact hit from the background. Use the lexical rules.
  const applyMargin =
    input.vectorsAvailable && documents >= thresholds.marginMinCorpus;
  const background = applyMargin ? unitCosine(input.backgroundCosine) : 0;
  const evidenceCosine = scored.anyRare ? scored.best.cosine : cosine;
  const margin = applyMargin ? evidenceCosine - background : 0;
  const decided = applyMargin
    ? labelWithVectors(scored, margin, thresholds)
    : labelLexical(scored, thresholds);
  return {
    label: decided.label,
    cosine,
    background,
    margin,
    rareShare: scored.best.uncommon,
    matchedRare: scored.matchedRare,
    commonDropped: scored.commonDropped,
    documents,
    documentFrequency: scored.terms,
    thresholds,
    vectorsAvailable: input.vectorsAvailable,
    rule: decided.rule,
    cosineSource: applyMargin
      ? evidenceSource(
          scored.anyRare,
          scored.best,
          scored.bestCosine,
          scored.sawVector,
          input.unmatchedCosine,
        )
      : "missing",
  };
}

/** Grounding from passage windows. Rank is not an input. */
export function assessStoredGrounding(
  input: Parameters<typeof explainStoredGrounding>[0],
): Grounding {
  return explainStoredGrounding(input).label;
}
