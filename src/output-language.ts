// Script first, then a few stopwords. No dictionary and no new dependency.
// Cyrillic majority is Russian. Latin text with no stopwords counts as English.
// A tie between Latin stopword lists is unknown, so it does not match.

export const DISTILL_LANGUAGES = ["ru", "en", "de", "fr", "es"] as const;
export type DistillLanguage = (typeof DISTILL_LANGUAGES)[number];

const LANGUAGE_NAME: Record<DistillLanguage, string> = {
  ru: "Russian",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
};

const STOPWORDS: Record<"en" | "de" | "fr" | "es", ReadonlySet<string>> = {
  en: new Set([
    "the",
    "and",
    "of",
    "to",
    "is",
    "that",
    "for",
    "with",
    "was",
    "are",
    "this",
    "from",
    "by",
    "not",
    "but",
    "have",
    "has",
    "were",
    "its",
    "which",
    "their",
    "they",
    "been",
    "be",
    "or",
    "an",
    "it",
    "on",
    "as",
    "at",
  ]),
  de: new Set([
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "ein",
    "eine",
    "einer",
    "einem",
    "einen",
    "mit",
    "auf",
    "für",
    "fuer",
    "von",
    "den",
    "dem",
    "des",
    "sich",
    "auch",
    "nach",
    "bei",
    "aus",
    "wird",
    "wurde",
    "sind",
    "oder",
    "aber",
    "wenn",
    "dass",
    "zum",
    "zur",
    "vom",
    "im",
  ]),
  fr: new Set([
    "le",
    "la",
    "les",
    "des",
    "une",
    "est",
    "pas",
    "dans",
    "pour",
    "que",
    "qui",
    "avec",
    "sur",
    "par",
    "cette",
    "ces",
    "aux",
    "elle",
    "sont",
    "ont",
    "mais",
    "comme",
    "plus",
    "nous",
    "vous",
  ]),
  es: new Set([
    "el",
    "los",
    "las",
    "la",
    "una",
    "del",
    "por",
    "para",
    "como",
    "pero",
    "sus",
    "este",
    "esta",
    "hay",
    "fue",
    "entre",
    "porque",
    "cuando",
    "donde",
    "también",
    "tambien",
    "que",
    "al",
    "su",
    "lo",
  ]),
};

export function distillLanguageName(language: DistillLanguage): string {
  return LANGUAGE_NAME[language];
}

/** `ru`, `en`, `de`, `fr`, or `es`. Any other value is ignored. */
export function distillLanguageOverride(
  env: NodeJS.ProcessEnv = process.env,
): DistillLanguage | undefined {
  const raw = env.CONTEXT_DISTILL_LANGUAGE?.trim().toLowerCase();
  if (!raw) return undefined;
  return (DISTILL_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as DistillLanguage)
    : undefined;
}

function scriptCounts(text: string): { cyr: number; lat: number } {
  let cyr = 0;
  let lat = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x0400 && code <= 0x04ff) ||
      (code >= 0x0500 && code <= 0x052f) ||
      (code >= 0x2de0 && code <= 0x2dff) ||
      (code >= 0xa640 && code <= 0xa69f)
    )
      cyr++;
    else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x024f)
    )
      lat++;
  }
  return { cyr, lat };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

function stopwordScores(
  text: string,
): Record<"en" | "de" | "fr" | "es", number> {
  const scores = { en: 0, de: 0, fr: 0, es: 0 };
  for (const word of words(text)) {
    if (STOPWORDS.en.has(word)) scores.en++;
    if (STOPWORDS.de.has(word)) scores.de++;
    if (STOPWORDS.fr.has(word)) scores.fr++;
    if (STOPWORDS.es.has(word)) scores.es++;
  }
  return scores;
}

/** `null` when the text has no letters or the Latin stopword lists tie. */
export function detectOutputLanguage(text: string): DistillLanguage | null {
  const { cyr, lat } = scriptCounts(text);
  if (cyr + lat === 0) return null;
  if (cyr > lat || (cyr > 0 && cyr === lat)) return "ru";
  const scores = stopwordScores(text);
  const ranked = (["en", "de", "fr", "es"] as const)
    .map((language) => ({ language, score: scores[language] }))
    .sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const second = ranked[1];
  if (!top || top.score === 0) return "en";
  if (!second || top.score > second.score) return top.language;
  return null;
}

export function outputLanguageMatches(
  text: string,
  expected: DistillLanguage,
): boolean {
  const detected = detectOutputLanguage(text);
  if (expected === "ru") return scriptCounts(text).cyr > scriptCounts(text).lat;
  if (detected === null) {
    if (expected !== "en") return false;
    const scores = stopwordScores(text);
    return (
      scores.de + scores.fr + scores.es === 0 && scriptCounts(text).lat > 0
    );
  }
  return detected === expected;
}

/** Language a distillation sentence must use for this source text. */
export function sourceLanguage(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): DistillLanguage {
  const override = distillLanguageOverride(env);
  if (override) return override;
  return detectOutputLanguage(text) ?? "en";
}

/**
 * Majority of item texts by count. A tie, including Russian against English,
 * is Russian. `CONTEXT_DISTILL_LANGUAGE` wins over the count.
 */
export function majorityLanguage(
  texts: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DistillLanguage {
  const override = distillLanguageOverride(env);
  if (override) return override;
  const counts = new Map<DistillLanguage, number>();
  for (const text of texts) {
    const language = sourceLanguage(text, {});
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  let best: DistillLanguage | undefined;
  let bestCount = 0;
  let tied = false;
  for (const [language, count] of counts) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) tied = true;
  }
  if (!best || tied) return "ru";
  return best;
}
