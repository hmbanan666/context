import { z } from "zod";
import { captureSchema, scopeSchema } from "./contracts.js";
import type { Source } from "./store.js";

const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value),
      "Use nonblank, well-formed Unicode without NUL characters",
    );

export const materialMetadataSchema = z.strictObject({
  type: z.enum(["note", "document"]).optional(),
  title: nonblank(256).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  sourceUri: z
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          value === value.trim() &&
          !value.includes("\0") &&
          !/[\uD800-\uDFFF]/u.test(value)
        );
      } catch {
        return false;
      }
    }, "Use an HTTP(S) source URL without credentials")
    .optional(),
});

export const captureMaterialSchema = captureSchema.extend({
  metadata: materialMetadataSchema.optional(),
});

export const maxMaterialFileBytes = 16 * 1024;

export function decodeMaterialFile(contentBase64: string): {
  bytes: Buffer;
  text: string;
} {
  const bytes = Buffer.from(contentBase64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maxMaterialFileBytes ||
    bytes.toString("base64") !== contentBase64
  ) {
    throw new Error("Use canonical base64 for a file of 1–16384 bytes");
  }
  // Preserve BOMs, line endings and all original bytes; malformed UTF-8 fails.
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  nonblank(maxMaterialFileBytes).parse(text);
  return { bytes, text };
}

export const captureFileSchema = z
  .strictObject({
    version: z.literal(1),
    scope: scopeSchema,
    origin: captureSchema.shape.origin,
    idempotencyKey: captureSchema.shape.idempotencyKey,
    filename: z
      .string()
      .min(4)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*\.(txt|md)$/)
      .refine((value) => !value.includes(".."), "Use a simple file name"),
    mediaType: z.enum(["text/plain", "text/markdown"]),
    contentBase64: z.string().min(4).max(21848),
    metadata: materialMetadataSchema.optional(),
  })
  .superRefine((input, context) => {
    if (
      (input.filename.endsWith(".txt") && input.mediaType !== "text/plain") ||
      (input.filename.endsWith(".md") && input.mediaType !== "text/markdown")
    ) {
      context.addIssue({
        code: "custom",
        path: ["mediaType"],
        message: "File extension must match the media type",
      });
    }
    if (input.metadata?.type === "note") {
      context.addIssue({
        code: "custom",
        path: ["metadata", "type"],
        message: "A file material has document type",
      });
    }
    try {
      decodeMaterialFile(input.contentBase64);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["contentBase64"],
        message:
          "Use canonical base64 for a nonblank UTF-8 file of 1–16384 bytes",
      });
    }
  });

export const materialLookupSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  id: captureSchema.shape.idempotencyKey,
});

export interface MaterialMetadata {
  readonly type: "note" | "document";
  readonly title?: string;
  readonly createdAt?: string;
  readonly sourceUri?: string;
}

export interface MaterialFileDescriptor {
  readonly filename: string;
  readonly mediaType: "text/plain" | "text/markdown";
  readonly byteLength: number;
  readonly checksum: string;
}

export interface Material {
  readonly source: Source;
  readonly metadata: MaterialMetadata;
  readonly file?: MaterialFileDescriptor;
}

export interface MaterialFile extends MaterialFileDescriptor {
  readonly contentBase64: string;
}

export type CaptureMaterialInput = z.infer<typeof captureMaterialSchema>;
export type CaptureFileInput = z.infer<typeof captureFileSchema>;
