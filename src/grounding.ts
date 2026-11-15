import { conceptCoverage } from "./search-lexical.js";

// Absolute evidence for whether anything relevant exists. Rank is not an input.
// A nearest neighbour can still be grounding "none".
//
// Lexical: share of non-stopword query terms that occur in any candidate,
// exact or stemmed. Glossary synonyms do not count; they expand the query,
// they are not the caller's words.
//
// Semantic: cosine of normalized multilingual-e5-small vectors. Retrieval still
// keeps a candidate once cosine reaches 0.80 (embedding-index.ts). Grounding
// uses a higher bar so a merely nearest passage is not treated as an answer.
// Defaults were checked on the public curated fixture. See docs/curated-instance.md.

export type Grounding = "strong" | "weak" | "none";

export interface GroundingThresholds {
  /** Minimum fraction of content terms that counts as strong. */
  readonly lexicalStrong: number;
  /** Cosine that counts as weak when the query terms themselves do not match. */
  readonly cosineWeak: number;
  /** Cosine that counts as strong when the query terms themselves do not match. */
  readonly cosineStrong: number;
}

export const defaultGroundingThresholds: GroundingThresholds = {
  lexicalStrong: 0.5,
  // Fixture measurement on multilingual-e5-small: off-topic neighbours stayed
  // under the 0.80 retrieval floor, and on-topic cosine was at least 0.853.
  cosineWeak: 0.84,
  cosineStrong: 0.92,
};

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

export function readGroundingThresholds(
  env: NodeJS.ProcessEnv,
): GroundingThresholds {
  const lexicalStrong = readUnit(
    env.CONTEXT_GROUNDING_LEXICAL_STRONG,
    defaultGroundingThresholds.lexicalStrong,
    "CONTEXT_GROUNDING_LEXICAL_STRONG",
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
  if (cosineStrong < cosineWeak)
    throw new Error("Invalid CONTEXT_GROUNDING_COSINE_STRONG");
  return { lexicalStrong, cosineWeak, cosineStrong };
}

const level: Record<Grounding, number> = { none: 0, weak: 1, strong: 2 };

/** Stemmed overlap with the caller's own content terms. No glossary synonyms. */
export function countQueryTerms(
  text: string,
  terms: readonly string[],
): number {
  return conceptCoverage(text, terms).concepts;
}

export function bestQueryTermMatches(
  texts: readonly string[],
  terms: readonly string[],
): number {
  let best = 0;
  for (const text of texts) {
    const matched = countQueryTerms(text, terms);
    if (matched > best) best = matched;
    if (terms.length > 0 && best >= terms.length) break;
  }
  return best;
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

export function assessGrounding(input: {
  readonly contentTerms: number;
  readonly matchedTerms: number;
  readonly cosine?: number;
  readonly thresholds?: GroundingThresholds;
}): Grounding {
  const thresholds = input.thresholds ?? readGroundingThresholds(process.env);
  const ratio =
    input.contentTerms > 0 ? input.matchedTerms / input.contentTerms : 0;
  const cosine = input.cosine ?? 0;
  const lexical: Grounding =
    input.matchedTerms > 0 && ratio >= thresholds.lexicalStrong
      ? "strong"
      : input.matchedTerms > 0
        ? "weak"
        : "none";
  const semantic: Grounding =
    cosine >= thresholds.cosineStrong
      ? "strong"
      : cosine >= thresholds.cosineWeak
        ? "weak"
        : "none";
  return level[semantic] > level[lexical] ? semantic : lexical;
}
