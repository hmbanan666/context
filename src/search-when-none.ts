import { isShareStop } from "./grounding.js";
import { itemsHint } from "./llm.js";

/** What to do with cards when grounding is none. */
export type WhenNone = "keep" | "empty";

export function readWhenNone(env: NodeJS.ProcessEnv): WhenNone {
  const value = env.CONTEXT_SEARCH_WHEN_NONE?.trim() ?? "";
  if (value === "" || value === "keep") return "keep";
  if (value === "empty") return "empty";
  throw new Error("CONTEXT_SEARCH_WHEN_NONE must be keep or empty");
}

export function resolveWhenNone(
  requested: WhenNone | undefined,
  env: NodeJS.ProcessEnv,
): WhenNone {
  return requested ?? readWhenNone(env);
}

/**
 * Keep a source card when its match score is at least this fraction of the
 * best source card. `0` disables the floor. Used only below the grounding
 * margin corpus size, where reciprocal-rank scores sit too close together
 * to separate a real hit from a neighbour that shares one word.
 */
export function readCardFloor(env: NodeJS.ProcessEnv): number {
  const raw = env.CONTEXT_SEARCH_CARD_FLOOR;
  if (raw === undefined || raw.trim() === "") return 0.5;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Invalid CONTEXT_SEARCH_CARD_FLOOR");
  return value;
}

/**
 * Content terms the card floor may count. Function words are out, the same
 * list grounding uses. On a handful of notes a word in half or more of them
 * (бот, сайт) is not rare either: it would otherwise keep every neighbour.
 */
export function cardFloorTerms(
  terms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documents: number,
): string[] {
  return terms.filter((term) => {
    if (isShareStop(term)) return false;
    const seen = documentFrequency.get(term) ?? 0;
    return !(documents >= 2 && seen * 2 >= documents);
  });
}

/**
 * Match score is the hybrid rank score plus how many floor terms the card
 * contains. Rank alone does not drop a one-word neighbour on a handful of
 * notes. The best card stays even if every score falls through the floor.
 */
export function idsWithinCardFloor(
  ids: readonly string[],
  scores: ReadonlyMap<string, number>,
  hits: ReadonlyMap<string, { readonly concepts: number }>,
  fraction: number,
): Set<string> {
  const keep = new Set(ids);
  if (!(fraction > 0) || ids.length <= 1) return keep;
  const relevance = new Map<string, number>();
  let top = 0;
  let best = ids[0];
  for (const id of ids) {
    const value = (scores.get(id) ?? 0) + (hits.get(id)?.concepts ?? 0);
    relevance.set(id, value);
    if (best === undefined || value > (relevance.get(best) ?? 0)) best = id;
    if (value > top) top = value;
  }
  if (!(top > 0)) return keep;
  const minimum = top * fraction;
  for (const id of ids) {
    if ((relevance.get(id) ?? 0) + 1e-12 < minimum) keep.delete(id);
  }
  if (keep.size === 0 && best !== undefined) keep.add(best);
  return keep;
}

/**
 * Drop cards when grounding is none and the caller or the instance asked for
 * that. The grounding label stays. `cardsOmitted` says why the lists are empty.
 */
export function presentSearchResult<
  T extends {
    grounding?: string;
    sources: unknown[];
    items: readonly unknown[];
    relations?: unknown[];
  },
>(
  data: T,
  requested: WhenNone | undefined,
  env: NodeJS.ProcessEnv,
): T & { itemsHint?: string; cardsOmitted?: "grounding-none" } {
  const hint = itemsHint(data.items.length, env);
  const whenNone = resolveWhenNone(requested, env);
  const shown: T & { cardsOmitted?: "grounding-none" } =
    whenNone === "empty" && data.grounding === "none"
      ? {
          ...data,
          sources: [],
          items: [],
          ...(data.relations ? { relations: [] } : {}),
          cardsOmitted: "grounding-none",
        }
      : data;
  return hint ? { ...shown, itemsHint: hint } : shown;
}
