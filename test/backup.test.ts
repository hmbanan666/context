import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import { SourceStore } from "../src/store.js";

test("online backup and offline restore retain source, FTS and persistent retry keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-backup-"));
  const source = join(directory, "source.db");
  const snapshot = join(directory, "snapshot.db");
  const restored = join(directory, "restored.db");
  const store = new SourceStore(source);
  const input = {
    version: 1 as const,
    text: "Synthetic silver otter",
    origin: "fixture:backup",
    scope: "synthetic:backup",
    idempotencyKey: "backup-001",
  };
  try {
    const saved = store.capture(input);
    await backupDatabase(source, snapshot);
    await assert.rejects(() => backupDatabase(source, snapshot));
    await assert.rejects(() => restoreDatabase(snapshot, source));
    await restoreDatabase(snapshot, restored);
    const clone = new SourceStore(restored);
    try {
      assert.deepEqual(clone.find(saved.source.id, input.scope), saved.source);
      assert.deepEqual(clone.search("silver otter", input.scope, 10), [
        saved.source,
      ]);
      assert.deepEqual(clone.capture(input), {
        source: saved.source,
        duplicate: true,
      });
    } finally {
      clone.close();
    }
    await writeFile(join(directory, "another.db-wal"), "synthetic-stale-wal");
    await assert.rejects(() =>
      restoreDatabase(snapshot, join(directory, "another.db")),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
