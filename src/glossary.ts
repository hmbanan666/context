import { stemText } from "./search-lexical.js";

export interface GlossaryEntry {
  readonly term: string;
  readonly synonyms: readonly string[];
}

// Generic RU→EN developer vocabulary. Project entries override the same stem.
// One-concept synonyms stay few so a single broad word cannot flood FTS.
// "tidy" is not a translation of дистилляция; a project glossary adds it.
export const builtinGlossary: readonly GlossaryEntry[] = [
  { term: "бэкап", synonyms: ["backup", "snapshot"] },
  { term: "бекап", synonyms: ["backup", "snapshot"] },
  { term: "резервная", synonyms: ["backup", "snapshot"] },
  { term: "снимок", synonyms: ["snapshot"] },
  { term: "репозиторий", synonyms: ["repository", "repo"] },
  { term: "коммит", synonyms: ["commit"] },
  { term: "ветка", synonyms: ["branch"] },
  { term: "деплой", synonyms: ["deploy", "deployment"] },
  { term: "миграция", synonyms: ["migration"] },
  { term: "эмбеддинг", synonyms: ["embedding", "embeddings"] },
  { term: "дистилляция", synonyms: ["distill", "distillation"] },
  { term: "ночная", synonyms: ["nightly"] },
  { term: "глоссарий", synonyms: ["glossary"] },
  { term: "переиндексация", synonyms: ["reindex"] },
  { term: "журнал", synonyms: ["journal"] },
  { term: "профиль", synonyms: ["profile"] },
  { term: "пакет", synonyms: ["pack"] },
  { term: "инструмент", synonyms: ["tool", "tools"] },
];

export const maxExpandedTerms = 24;
export const maxGlossaryWords = 4;

export function phraseWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function wordStem(word: string): string {
  return stemText(word.toLowerCase());
}

/**
 * Snowball equality, plus one inserted о/е/ё. ночную and ночная already share
 * ночн. список/списка and покупок/покупки do not: Snowball leaves the
 * nominative or the genitive plural one fleeting vowel away. A raw prefix
 * would also match ночн to ночник, so the extra vowel is the whole allowance.
 */
export function stemsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < longer.length; i++) {
    const letter = longer[i];
    if (letter !== "о" && letter !== "е" && letter !== "ё") continue;
    if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
  }
  return false;
}

export function glossaryWordsMatch(
  queryWord: string,
  entryWord: string,
): boolean {
  return stemsMatch(wordStem(queryWord), wordStem(entryWord));
}

/** Project entries replace a built-in entry with the same stem. */
export function mergeGlossary(
  builtin: readonly GlossaryEntry[],
  project: readonly GlossaryEntry[],
): GlossaryEntry[] {
  const byStem = new Map<string, GlossaryEntry>();
  for (const entry of [...builtin, ...project])
    byStem.set(stemText(entry.term.toLowerCase()), entry);
  return [...byStem.values()];
}

interface IndexedEntry {
  stems: string[];
  synonyms: readonly string[];
}

function phraseAt(
  queryStems: readonly string[],
  start: number,
  phrase: readonly string[],
): boolean {
  if (start + phrase.length > queryStems.length) return false;
  return phrase.every((stem, offset) =>
    stemsMatch(queryStems[start + offset] ?? "", stem),
  );
}

/**
 * Synonyms for query tokens, in query order. A single word matches by stem,
 * including one fleeting vowel. A multi-word term matches a run of query
 * words the same way, and its synonym is kept as a phrase for FTS. Terms
 * already in the query are omitted. Capped so an OR-query cannot grow.
 */
export function expandQueryTerms(
  terms: readonly string[],
  entries: readonly GlossaryEntry[],
): string[] {
  const indexed: IndexedEntry[] = entries.map((entry) => ({
    stems: phraseWords(entry.term).map((word) => wordStem(word)),
    synonyms: entry.synonyms,
  }));
  const phrases = indexed
    .filter((entry) => entry.stems.length > 1)
    .sort((a, b) => b.stems.length - a.stems.length);
  const singles = indexed.filter((entry) => entry.stems.length === 1);
  const queryStems = terms.map((term) => wordStem(term));
  const original = new Set(terms.map((term) => term.toLowerCase()));
  const originalStems = new Set(queryStems);
  const expanded: string[] = [];
  const seen = new Set<string>();
  const add = (synonyms: readonly string[]): boolean => {
    for (const synonym of synonyms) {
      const token = synonym.toLowerCase();
      const words = phraseWords(token);
      if (
        words.length > 0 &&
        words.every(
          (word) => original.has(word) || originalStems.has(wordStem(word)),
        )
      )
        continue;
      if (seen.has(token)) continue;
      if (expanded.length >= maxExpandedTerms) return false;
      expanded.push(token);
      seen.add(token);
    }
    return true;
  };
  for (let index = 0; index < terms.length; index++) {
    for (const phrase of phrases) {
      if (!phraseAt(queryStems, index, phrase.stems)) continue;
      if (!add(phrase.synonyms)) return expanded;
    }
    const stem = queryStems[index] ?? "";
    const exact = singles.filter((entry) => entry.stems[0] === stem);
    const chosen = exact.length
      ? exact
      : singles.filter((entry) => stemsMatch(stem, entry.stems[0] ?? ""));
    for (const entry of chosen) if (!add(entry.synonyms)) return expanded;
  }
  return expanded;
}
