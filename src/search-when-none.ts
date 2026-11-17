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
