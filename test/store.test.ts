import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { syntheticSource } from "../fixtures/synthetic-source.js";
import { SourceStore } from "../src/store.js";

test("preserves exact source, provenance and conservative status", () => {
  const store = new SourceStore(":memory:");
  try {
    const record = store.insert(syntheticSource);
    assert.deepEqual(store.find(record.id, record.scope), {
      ...syntheticSource,
      checksum: createHash("sha256").update(syntheticSource.text).digest("hex"),
      status: "unreviewed",
    });
    assert.equal(store.find(record.id, "another:scope"), undefined);
    assert.equal(store.find("missing", record.scope), undefined);
    assert.equal(store.find("' OR 1=1 --", record.scope), undefined);
    assert.equal(store.find(record.id, "' OR 1=1 --"), undefined);
  } finally {
    store.close();
  }
});

test("duplicate IDs cannot overwrite original content or change scope", () => {
  const store = new SourceStore(":memory:");
  try {
    const original = store.insert(syntheticSource);
    assert.throws(() => store.insert({ ...syntheticSource, text: "changed" }));
    assert.throws(() => store.insert({ ...syntheticSource, scope: "other" }));
    assert.deepEqual(store.find(original.id, original.scope), original);
  } finally {
    store.close();
  }
});

test("rejects missing provenance or invalid timestamp without storing input", () => {
  const store = new SourceStore(":memory:");
  try {
    for (const field of ["id", "text", "origin", "scope", "capturedAt"]) {
      assert.throws(() => store.insert({ ...syntheticSource, [field]: "" }));
    }
    assert.equal(
      store.find(syntheticSource.id, syntheticSource.scope),
      undefined,
    );
  } finally {
    store.close();
  }
});
