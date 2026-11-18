/** Mutable phase totals for one search, in milliseconds. */
export interface SearchPhases {
  embedMs: number;
  retrievalMs: number;
  groundingMs: number;
}

export function emptyPhases(): SearchPhases {
  return { embedMs: 0, retrievalMs: 0, groundingMs: 0 };
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
    }),
  );
}
