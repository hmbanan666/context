import { readFile } from "node:fs/promises";
import { KnowledgeStore } from "../src/knowledge.js";
import { applyOwnerReview } from "../src/owner-review.js";
import { SourceStore } from "../src/store.js";

const [databasePath, publicKeyPath, receiptPath, ...extra] =
  process.argv.slice(2);
let sources: SourceStore | undefined;
let knowledge: KnowledgeStore | undefined;
try {
  if (!databasePath || !publicKeyPath || !receiptPath || extra.length)
    throw new Error("Expected DATABASE TRUSTED_PUBLIC_KEY SIGNED_RECEIPT");
  const [publicKey, rawReceipt] = await Promise.all([
    readFile(publicKeyPath, "utf8"),
    readFile(receiptPath, "utf8"),
  ]);
  if (Buffer.byteLength(rawReceipt) > 8192)
    throw new Error("Receipt too large");
  sources = new SourceStore(databasePath);
  knowledge = new KnowledgeStore(databasePath);
  const result = applyOwnerReview(knowledge, JSON.parse(rawReceipt), publicKey);
  console.log(
    JSON.stringify({
      id: result.item.id,
      status: result.item.status,
      duplicate: result.duplicate,
    }),
  );
} catch {
  console.error(
    "Owner review rejected; verify the trusted key, signed receipt and scoped item",
  );
  process.exitCode = 1;
} finally {
  knowledge?.close();
  sources?.close();
}
