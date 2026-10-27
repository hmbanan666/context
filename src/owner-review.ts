import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  type KnowledgeStore,
  type ReviewKnowledgeInput,
  reviewKnowledgeSchema,
} from "./knowledge.js";

export const ownerReviewReceiptSchema = z.strictObject({
  review: reviewKnowledgeSchema,
  signature: z
    .string()
    .length(88)
    .regex(/^[A-Za-z0-9+/]{86}==$/),
});

// Fixed field order and a domain separator bind signatures to this protocol.
export function ownerReviewPayload(input: ReviewKnowledgeInput): Buffer {
  const review = reviewKnowledgeSchema.parse(input);
  return Buffer.from(
    JSON.stringify([
      "context-owner-review-v1",
      review.version,
      review.scope,
      review.id,
      review.idempotencyKey,
      review.status,
      review.evidence,
    ]),
    "utf8",
  );
}

export function applyOwnerReview(
  store: KnowledgeStore,
  receipt: unknown,
  trustedPublicKey: string | Buffer,
) {
  const { review, signature } = ownerReviewReceiptSchema.parse(receipt);
  const key = createPublicKey(trustedPublicKey);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Require Ed25519 review key");
  const bytes = Buffer.from(signature, "base64");
  if (
    bytes.toString("base64") !== signature ||
    !verify(null, ownerReviewPayload(review), key, bytes)
  )
    throw new Error("Invalid owner review signature");
  const subject = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  return store.review(review, {
    kind: "verified-owner-signature",
    subject,
    authenticated: true,
    signature,
  });
}
