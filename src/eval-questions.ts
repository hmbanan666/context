import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parseDocument } from "yaml";
import { z } from "zod";
import { scopeSchema } from "./contracts.js";
import { contextPackageSchema } from "./package-query.js";
import { projectIdSchema } from "./projects.js";

const areas = z
  .array(scopeSchema)
  .max(8)
  .refine((a) => new Set(a).size === a.length);
const matcher = z.union([
  z.strictObject({ source_external_id: z.string().min(1).max(2048) }),
  z.strictObject({ source_id: z.string().min(1).max(128) }),
  z.strictObject({ item_id: z.string().min(1).max(128) }),
  z.strictObject({ substring: z.string().min(1).max(2048) }),
]);
export const evalQuestionSchema = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    question: contextPackageSchema.shape.question,
    areas: areas.refine((a) => a.length > 0),
    read_areas: areas,
    project: projectIdSchema.optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    mode: z.enum(["pack"]).optional(),
    budget_bytes: z.number().int().min(512).max(65536).optional(),
    expected: z.array(matcher).max(100),
    outranks: z.array(matcher).min(1).max(100).optional(),
    forbidden_areas: areas.default([]),
    forbidden_substrings: z
      .array(z.string().min(1).max(2048))
      .max(20)
      .optional(),
    expect_truncated: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(64)).max(16).default([]),
    placeholder: z.boolean().default(false),
  })
  .refine(
    (q) =>
      (q.placeholder ||
        q.expected.length > 0 ||
        q.forbidden_areas.length > 0) &&
      (!q.outranks || q.expected.length > 0),
  )
  .refine(
    (q) => !q.since || !q.until || Date.parse(q.since) < Date.parse(q.until),
    { message: "since must precede until" },
  )
  .refine((q) => q.mode !== "pack" || q.project !== undefined, {
    message: "pack mode requires a project",
  });
export type EvalQuestion = z.infer<typeof evalQuestionSchema>;
const fileSchema = z
  .strictObject({ questions: z.array(evalQuestionSchema).min(1).max(500) })
  .refine(
    ({ questions }) =>
      new Set(questions.map((q) => q.id)).size === questions.length,
  );

export async function readEvalQuestions(path: string) {
  const file = await open(path, "r");
  try {
    // Bound allocation even when the file grows after opening; disallow YAML aliases.
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length === bytes.length) throw new Error("Eval file too large");
    const content = bytes.subarray(0, length);
    const document = parseDocument(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
      { uniqueKeys: true },
    );
    if (document.errors.length) throw new Error("Invalid eval file");
    const parsed = fileSchema.parse(document.toJS({ maxAliasCount: 0 }));
    return {
      questions: parsed.questions,
      hash: createHash("sha256").update(content).digest("hex"),
    };
  } finally {
    await file.close();
  }
}
