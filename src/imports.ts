import { ZodError } from "zod";
import {
  importLineSchema,
  importSourceSchema,
  maxImportLineBytes,
} from "./import-format.js";
import { boundedLines } from "./jsonl.js";
import { redact, redactMetadata } from "./redaction.js";
import type { SourceStore } from "./store.js";

class RejectedImport extends Error {}

export interface ImportOptions {
  source: string;
  area?: string;
  areas: readonly string[];
}
export interface ImportSummary {
  type: "summary";
  created: number;
  skipped: number;
  changed: number;
  rejected: number;
}
export type ImportResult =
  | {
      type: "item";
      line: number;
      status: "created" | "skipped" | "changed" | "rejected";
      source_id?: string;
      reason?: string;
    }
  | ImportSummary;

export async function importJsonl(
  store: SourceStore,
  input: AsyncIterable<Uint8Array | string>,
  options: ImportOptions,
  emit: (result: ImportResult) => void | Promise<void>,
): Promise<ImportSummary> {
  const source = importSourceSchema.parse(options.source);
  if (redact(source) !== source) throw new Error("Unsafe source name");
  const summary: ImportSummary = {
    type: "summary",
    created: 0,
    skipped: 0,
    changed: 0,
    rejected: 0,
  };
  let line = 0;
  for await (const raw of boundedLines(input, maxImportLineBytes)) {
    line++;
    let result: ImportResult;
    try {
      if (raw === null)
        throw new RejectedImport("line_too_large_or_invalid_utf8");
      const item = importLineSchema.parse(JSON.parse(raw));
      // Identity must never silently collapse after redaction.
      if (redact(item.id) !== item.id)
        throw new RejectedImport("unsafe_identity");
      const requested = item.area ?? options.area ?? "inbox";
      const area = options.areas.includes(requested)
        ? requested
        : options.areas.includes("inbox")
          ? "inbox"
          : undefined;
      if (!area) throw new RejectedImport("unknown_area_without_inbox");
      const saved = store.importMaterial(
        {
          version: 1,
          text: redact(item.text),
          origin: `import:${source}`,
          scope: area,
          idempotencyKey: "import",
          metadata: {
            type:
              item.kind === "note" || item.kind === undefined
                ? "note"
                : "document",
            ...(item.title === undefined ? {} : { title: redact(item.title) }),
            ...(item.created_at === undefined
              ? {}
              : { createdAt: item.created_at }),
            ...(item.url === undefined ? {} : { sourceUri: redact(item.url) }),
          },
        },
        {
          source,
          externalId: item.id,
          ...(item.kind === undefined ? {} : { kind: redact(item.kind) }),
          metadata: redactMetadata(item.metadata ?? {}),
        },
      );
      result = {
        type: "item",
        line,
        status: saved.duplicate
          ? "skipped"
          : saved.changed
            ? "changed"
            : "created",
        source_id: saved.source.id,
      };
    } catch (error) {
      result = {
        type: "item",
        line,
        status: "rejected",
        reason:
          error instanceof RejectedImport
            ? error.message
            : error instanceof SyntaxError || error instanceof ZodError
              ? "invalid_item"
              : "storage_failure_retryable",
      };
    }
    summary[result.status]++;
    await emit(result);
  }
  await emit(summary);
  return summary;
}
