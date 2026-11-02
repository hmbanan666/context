import { once } from "node:events";
import {
  type ImportLine,
  importLineSchema,
  maxImportTextLength,
} from "./import-format.js";
import { redact, redactMetadata } from "./redaction.js";

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit - 15).replace(/[\uD800-\uDBFF]$/, "");
  return `${head}\n[truncated]`;
}

export function collectedItem(item: ImportLine): ImportLine {
  if (redact(item.id) !== item.id) throw new Error("Unsafe collector identity");
  const text = redact(item.text);
  return importLineSchema.parse({
    ...item,
    text: truncate(text, maxImportTextLength),
    ...(item.title === undefined
      ? {}
      : { title: truncate(redact(item.title), 256) }),
    ...(item.url === undefined ? {} : { url: redact(item.url) }),
    metadata: {
      ...redactMetadata(item.metadata ?? {}),
      ...(text.length > maxImportTextLength ? { truncated: "true" } : {}),
    },
  });
}

export async function writeCollected(
  items: AsyncIterable<ImportLine>,
): Promise<void> {
  let count = 0;
  let bytes = 0;
  const groups: Record<string, number> = {};
  for await (const item of items) {
    const line = `${JSON.stringify(collectedItem(item))}\n`;
    bytes += Buffer.byteLength(line);
    count++;
    const group = item.id.startsWith("github:")
      ? (item.metadata?.repo ?? "github")
      : item.id.startsWith("codex-task:")
        ? "codex-task"
        : "codex";
    groups[group] = (groups[group] ?? 0) + 1;
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  }
  process.stderr.write(
    `${JSON.stringify({ type: "summary", items: count, bytes, groups })}\n`,
  );
}
