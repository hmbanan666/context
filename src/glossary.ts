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

/**
 * Synonyms for query tokens, in query order. Inflected tokens match the
 * glossary by stem. Terms already in the query are omitted. Capped so an
 * OR-query cannot grow without bound.
 */
export function expandQueryTerms(
  terms: readonly string[],
  entries: readonly GlossaryEntry[],
): string[] {
  const byExact = new Map<string, readonly string[]>();
  const byStem = new Map<string, readonly string[]>();
  for (const entry of entries) {
    const term = entry.term.toLowerCase();
    byExact.set(term, entry.synonyms);
    byStem.set(stemText(term), entry.synonyms);
  }
  const original = new Set(terms.map((term) => term.toLowerCase()));
  const originalStems = new Set(terms.map((term) => stemText(term)));
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const synonyms =
      byExact.get(term.toLowerCase()) ?? byStem.get(stemText(term)) ?? [];
    for (const synonym of synonyms) {
      const token = synonym.toLowerCase();
      if (original.has(token) || originalStems.has(stemText(token))) continue;
      if (seen.has(token)) continue;
      if (expanded.length >= maxExpandedTerms) return expanded;
      expanded.push(token);
      seen.add(token);
    }
  }
  return expanded;
}
