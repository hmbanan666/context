const marker = "[REDACTED]";
const secretKey =
  /(?:^|[_-])(?:token|password|passwd|secret|api[_-]?key|authorization|credential|private[_-]?key)(?:$|[_-])/i;

// Deliberately deterministic: retries compare the retained, redacted input.
// Pattern matching is a best-effort filter, not detection of arbitrary secrets.
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      marker,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g,
      marker,
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, marker)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${marker}`)
    .replace(
      /(\b(?:[A-Z0-9]+[_-])*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|authorization|credential)(?:[_-][A-Z0-9]+)*\b["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&"'<>]+)/gi,
      `$1${marker}`,
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${marker}@`);
}

export function redactMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      redact(key),
      secretKey.test(key) ? marker : redact(value),
    ]),
  );
}

// Apply the same filter to every string in validated ingest data. Validate again
// afterwards: identities/filenames that cannot contain the marker fail closed.
export function redactFields<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactFields) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactFields(item)]),
    ) as T;
  return value;
}
