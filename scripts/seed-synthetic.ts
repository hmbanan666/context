import { syntheticSource } from "../fixtures/synthetic-source.js";
import { readConfig } from "../src/config.js";
import { SourceStore } from "../src/store.js";

try {
  const store = new SourceStore(readConfig(process.env).databasePath);
  try {
    const existing = store.find(syntheticSource.id, syntheticSource.scope);
    if (!existing) {
      store.insert(syntheticSource);
    } else if (
      existing.text !== syntheticSource.text ||
      existing.origin !== syntheticSource.origin ||
      existing.capturedAt !== syntheticSource.capturedAt
    ) {
      throw new Error("Synthetic fixture conflicts with stored record");
    }
    console.log("Synthetic fixture ready");
  } finally {
    store.close();
  }
} catch {
  console.error("Synthetic seed failed; check local configuration and fixture");
  process.exitCode = 1;
}
