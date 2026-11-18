/** Mutable phase totals for one search, in milliseconds. */
export interface SearchPhases {
  embedMs: number;
  retrievalMs: number;
  groundingMs: number;
  /** Part of `groundingMs`: query cosine against the cached centroid. */
  centroidMs: number;
  /** Part of `groundingMs`: document-frequency lookup for the query terms. */
  frequencyMs: number;
  /**
   * Part of `groundingMs`: stored chunk cosines for the candidate set and
   * passage scoring. This is not a second embedding pass.
   */
  passageMs: number;
}

export function emptyPhases(): SearchPhases {
  return {
    embedMs: 0,
    retrievalMs: 0,
    groundingMs: 0,
    centroidMs: 0,
    frequencyMs: 0,
    passageMs: 0,
  };
}

export function addPhase(
  phases: SearchPhases | undefined,
  key: keyof SearchPhases,
  started: number,
): void {
  if (!phases) return;
  phases[key] += performance.now() - started;
}

export function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

/** One stderr line per search. Query text stays out of this line. */
export function writeSearchLog(tookMs: number, phases: SearchPhases): void {
  console.error(
    JSON.stringify({
      event: "search",
      tookMs,
      embedMs: Math.round(phases.embedMs),
      retrievalMs: Math.round(phases.retrievalMs),
      groundingMs: Math.round(phases.groundingMs),
      centroidMs: Math.round(phases.centroidMs),
      frequencyMs: Math.round(phases.frequencyMs),
      passageMs: Math.round(phases.passageMs),
    }),
  );
}
