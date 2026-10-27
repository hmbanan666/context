import { z } from "zod";

export const scopeSchema = z
  .string()
  .max(80)
  .regex(/^synthetic:[a-z0-9][a-z0-9:_-]*$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0)
    // Unicode-mode matching catches unpaired surrogates, but permits emoji pairs.
    .refine((s) => !s.includes("\0") && !/[\uD800-\uDFFF]/u.test(s), {
      message: "Use well-formed Unicode without NUL characters",
    });

export const captureSchema = z.strictObject({
  version: z.literal(1),
  text: nonblank(8192),
  origin: nonblank(256),
  scope: scopeSchema,
  idempotencyKey: identifier,
});

export const recallSchema = z
  .strictObject({
    version: z.literal(1),
    scope: scopeSchema,
    id: identifier.optional(),
    query: nonblank(256).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .refine((input) => (input.id === undefined) !== (input.query === undefined), {
    message: "Provide exactly one of id or query",
  });

export type CaptureInput = z.infer<typeof captureSchema>;
