import { ModelUnavailableError } from "./processor.js";
import { redact } from "./redaction.js";

// One failed Codex call used to collapse the whole tidy run into
// `llm: "unavailable"` with no cause. These reasons are safe to store:
// they name the class of failure, not the prompt or the model text.
export const LLM_FAILURE_REASONS = [
  "timeout",
  "rate_limit",
  "nonzero_exit",
  "parse",
  "unavailable",
] as const;
export type LlmFailureReason = (typeof LLM_FAILURE_REASONS)[number];
export const LLM_ATTEMPT_LIMIT = 3;
export const LLM_RETRY_BACKOFF_MS = [500, 1500] as const;
const STDERR_TAIL_CHARS = 240;

export interface LlmFailureReport {
  reason: LlmFailureReason;
  exitCode: number | null;
  attempt: number;
  stderrTail: string;
  abandoned: boolean;
}

export class LlmCallError extends ModelUnavailableError {
  readonly reason: LlmFailureReason;
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly transient: boolean;
  constructor(
    reason: LlmFailureReason,
    options: {
      exitCode?: number | null;
      stderrTail?: string;
      transient?: boolean;
    } = {},
  ) {
    super(reason);
    this.name = "LlmCallError";
    this.reason = reason;
    this.exitCode = options.exitCode ?? null;
    this.stderrTail = publicStderrTail(options.stderrTail ?? "");
    this.transient =
      options.transient ??
      (reason === "timeout" ||
        reason === "rate_limit" ||
        reason === "nonzero_exit");
  }
}

/** Last slice of a child diagnostic, with tokens and passwords removed. */
export function publicStderrTail(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const redacted = redact(flat);
  return redacted.length > STDERR_TAIL_CHARS
    ? redacted.slice(-STDERR_TAIL_CHARS)
    : redacted;
}

export function rateLimited(text: string): boolean {
  return /rate limit|too many requests|usage limit|\b429\b|quota exceeded/i.test(
    text,
  );
}

export function classifyLlmError(error: unknown): LlmCallError {
  if (error instanceof LlmCallError) return error;
  if (error instanceof Error && error.name === "TimeoutError")
    return new LlmCallError("timeout");
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out/i.test(message)) return new LlmCallError("timeout");
  if (rateLimited(message)) return new LlmCallError("rate_limit");
  if (/invalid_output|unexpected token|json/i.test(message))
    return new LlmCallError("parse", { transient: false });
  return new LlmCallError("unavailable", { transient: false });
}

export interface LlmAsker {
  ask(instruction: string, data: unknown): Promise<unknown>;
}

/**
 * Retry timeout, rate limit and non-zero exit. Each attempt counts toward
 * the caller's cap. Parse failures and a missing processor are not retried.
 */
export async function askLlm(
  llm: LlmAsker,
  instruction: string,
  data: unknown,
  options: {
    canAttempt: () => boolean;
    onAttempt: () => void;
    onFailure: (
      failure: LlmCallError,
      attempt: number,
      abandoned: boolean,
    ) => void;
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<unknown> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoff = options.backoffMs ?? LLM_RETRY_BACKOFF_MS;
  let last: LlmCallError | undefined;
  for (let attempt = 1; attempt <= LLM_ATTEMPT_LIMIT; attempt++) {
    if (!options.canAttempt()) break;
    options.onAttempt();
    try {
      return await llm.ask(instruction, data);
    } catch (error) {
      last = classifyLlmError(error);
      const abandoned =
        !last.transient ||
        attempt === LLM_ATTEMPT_LIMIT ||
        !options.canAttempt();
      options.onFailure(last, attempt, abandoned);
      if (abandoned) break;
      const delay = backoff[attempt - 1] ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }
  throw (
    last ??
    new LlmCallError("unavailable", {
      transient: false,
    })
  );
}
