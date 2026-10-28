import { z } from "zod";
import { captureSchema, personalDataScope, scopeSchema } from "./contracts.js";

export const contextPackageSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    scope: scopeSchema.default(personalDataScope),
    question: captureSchema.shape.text.pipe(z.string().max(512)),
    mode: z.enum(["search", "timeline"]).default("search"),
    from: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(20).default(8),
    maxBytes: z.number().int().min(2048).max(65536).default(8192),
  })
  .refine(
    (r) => !r.from || !r.until || Date.parse(r.from) < Date.parse(r.until),
    { message: "from must precede until" },
  );
export type PackageRequest = z.infer<typeof contextPackageSchema>;
export type PackageSelection = Pick<
  PackageRequest,
  "scope" | "from" | "until"
> & { terms: readonly string[]; limit: number };
// Small explicit question-word list, not a language model, stemmer or synonym map.
const stop = new Set(
  "a an the what which who why how did does do was were is are of in on at to for and or my me about happened suitable что какие какой как почему кто где когда это у я мои моих меня в на для и или о об по из происходило подходит подходят известно".split(
    " ",
  ),
);
export function questionTerms(question: string): string[] {
  const terms = [
    ...new Set(
      (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (t) => !stop.has(t),
      ),
    ),
  ];
  if (!terms.length || terms.length > 32)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["question"],
        message: "Use 1–32 content words, or explicit timeline mode",
      },
    ]);
  return terms;
}
export function ftsTerms(terms: readonly string[]): string {
  if (!terms.length || terms.length > 32)
    throw new Error("Invalid search terms");
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

// Paired with highlight(index, 0, ' ', ''): the first inserted space differs
// from the first matched token (which cannot start with ASCII whitespace).
// Comparing unmodified prefixes yields an original UTF-16 offset without
// inventing tokenization/case-fold rules or relying on collision-free markers.
export function ftsMatchOffset(text: string, highlighted: unknown): number {
  if (typeof highlighted !== "string") return 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== highlighted[i]) return i;
  }
  return 0;
}
