import { createHash } from "node:crypto";
import { z } from "zod";
import { personalDataScope, recallSchema } from "./contracts.js";
import type { Material } from "./materials.js";
import type { MemoryPosition, SourceStore } from "./store.js";

export const memoryContextSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    from: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    query: recallSchema.shape.query,
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    maxBytes: z.number().int().min(1024).max(65536).default(32768),
  })
  .refine(
    (input) =>
      !input.from ||
      !input.until ||
      Date.parse(input.from) < Date.parse(input.until),
    {
      message: "from must precede the exclusive until boundary",
    },
  );

const cursorSchema = z.strictObject({
  version: z.literal(1),
  selection: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  after: z.strictObject({
    timestamp: z.number().int().min(-8640000000000000).max(8640000000000000),
    row: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
});

export class InvalidMemoryCursor extends Error {}

interface MemoryContext {
  version: 1;
  scope: string;
  generatedAt: string;
  dateBasis: "source_created_at_else_captured_at";
  search: "timeline" | "any_keyword";
  totalMatchingSources: number;
  sources: Material[];
  oversizedSources: { id: string; requiredBytes: number }[];
  nextCursor: string | null;
  truncated: boolean;
}

// This deterministic retrieval layer returns evidence; the calling model synthesizes it.
// Authorization is checked by the tool before any count, cursor or source is read.
export function buildMemoryContext(
  sources: SourceStore,
  input: z.input<typeof memoryContextSchema>,
): MemoryContext {
  const request = memoryContextSchema.parse(input);
  const terms = [
    ...new Set(request.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  // Punctuation-only searches must not silently turn into an unfiltered archive read.
  if (request.query !== undefined && (terms.length === 0 || terms.length > 16))
    throw new z.ZodError([
      {
        code: "custom",
        path: ["query"],
        message: "Use 1–16 keywords or omit query for a timeline",
      },
    ]);
  const selection = createHash("sha256")
    .update(
      JSON.stringify([
        personalDataScope,
        request.from ?? null,
        request.until ?? null,
        terms,
      ]),
    )
    .digest("hex");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (request.cursor !== undefined) {
    try {
      const bytes = Buffer.from(request.cursor, "base64url");
      if (bytes.toString("base64url") !== request.cursor)
        throw new InvalidMemoryCursor();
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.selection !== selection || cursor.after.row > cursor.snapshot)
        throw new InvalidMemoryCursor();
    } catch {
      throw new InvalidMemoryCursor();
    }
  }
  const selected = sources.selectMemory({
    scope: personalDataScope,
    terms,
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.until === undefined ? {} : { until: request.until }),
    ...(cursor ? { snapshot: cursor.snapshot, after: cursor.after } : {}),
    limit: request.limit + 1,
  });
  const continuation = (position: MemoryPosition) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        selection,
        snapshot: selected.snapshot,
        after: position,
      }),
    ).toString("base64url");
  let context: MemoryContext = {
    version: 1,
    scope: personalDataScope,
    generatedAt: new Date().toISOString(),
    dateBasis: "source_created_at_else_captured_at",
    search: terms.length ? "any_keyword" : "timeline",
    totalMatchingSources: selected.total,
    sources: [],
    oversizedSources: [],
    nextCursor: null,
    truncated: !!cursor,
  };
  for (const [index, entry] of selected.entries
    .slice(0, request.limit)
    .entries()) {
    const nextCursor =
      index + 1 < selected.entries.length ? continuation(entry.position) : null;
    const candidate = {
      ...context,
      sources: [...context.sources, entry.material],
      nextCursor,
      truncated: !!cursor || nextCursor !== null,
    };
    const requiredBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (requiredBytes > request.maxBytes) {
      // Leave the next source on the next page, unless it cannot fit on a page alone.
      // Oversized originals remain explicitly discoverable via read_material.
      if (context.sources.length === 0) {
        context = {
          ...context,
          oversizedSources: [{ id: entry.material.source.id, requiredBytes }],
          nextCursor,
          truncated: true,
        };
      }
      break;
    }
    context = candidate;
  }
  return context;
}
