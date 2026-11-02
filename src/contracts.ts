import { z } from "zod";

export const operationScopes = [
  "context:read",
  "context:write",
  "context:process",
] as const;
export type OperationScope = (typeof operationScopes)[number];

export const personalDataScope = "personal";

// Colons remain valid so existing databases can retain their original area names.
export const scopeSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9:_-]*$/)
  .refine(
    (scope) => !scope.startsWith("context:") && scope !== "offline_access",
    {
      message: "An area cannot be an OAuth operation or refresh scope",
    },
  );
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const nonblankText = (max: number) =>
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
  text: nonblankText(8192),
  origin: nonblankText(256),
  scope: scopeSchema,
  idempotencyKey: identifierSchema,
});

export const recallSchema = z
  .strictObject({
    version: z.literal(1),
    scope: scopeSchema,
    id: identifierSchema.optional(),
    query: nonblankText(256).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .refine((input) => (input.id === undefined) !== (input.query === undefined), {
    message: "Provide exactly one of id or query",
  });

export type CaptureInput = z.infer<typeof captureSchema>;
