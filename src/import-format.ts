import { z } from "zod";
import { captureSchema } from "./contracts.js";
import { materialMetadataSchema } from "./materials.js";

export const maxImportLineBytes = 128 * 1024;
export const maxImportTextLength = 8192;
const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0 && !/\p{Cc}|[\uD800-\uDFFF]/u.test(s));
export const importSourceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const importLineSchema = z.strictObject({
  id: label(1024),
  text: captureSchema.shape.text,
  title: materialMetadataSchema.shape.title,
  created_at: materialMetadataSchema.shape.createdAt,
  area: label(80).optional(),
  kind: label(64).optional(),
  url: materialMetadataSchema.shape.sourceUri,
  metadata: z
    .record(
      label(128),
      z
        .string()
        .max(2048)
        .refine((s) => !s.includes("\0") && !/[\uD800-\uDFFF]/u.test(s)),
    )
    .refine((m) => Object.keys(m).length <= 32)
    .optional(),
});
export type ImportLine = z.infer<typeof importLineSchema>;
export interface ImportProvenance {
  source: string;
  externalId: string;
  kind?: string;
  metadata: Record<string, string>;
}
