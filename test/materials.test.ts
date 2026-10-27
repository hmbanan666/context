import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import {
  type CaptureFileInput,
  type CaptureMaterialInput,
  captureFileSchema,
} from "../src/materials.js";
import { IdempotencyConflict, SourceStore } from "../src/store.js";

const materialInput: CaptureMaterialInput = {
  version: 1,
  scope: "synthetic:materials",
  text: "Synthetic idea: a paper observatory on the moon.",
  origin: "fixture:materials",
  idempotencyKey: "material-001",
  metadata: {
    type: "note",
    title: "Paper observatory",
    createdAt: "2026-10-25T10:00:00+02:00",
    sourceUri: "https://example.com/synthetic-source",
  },
};

const fileInput: CaptureFileInput = {
  version: 1,
  scope: "synthetic:materials",
  origin: "fixture:materials-file",
  idempotencyKey: "file-001",
  filename: "synthetic-moon.md",
  mediaType: "text/markdown",
  contentBase64: "77u/IyBTeW50aGV0aWMgbW9vbg0KU25vdzog4piD77iPDQo=",
  metadata: { title: "Synthetic moon file" },
};

test("material migration preserves legacy source identity and v1 retry keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-material-migrate-"));
  const path = join(directory, "context.db");
  const request = {
    version: 1 as const,
    scope: materialInput.scope,
    text: materialInput.text,
    origin: materialInput.origin,
    idempotencyKey: "legacy-001",
  };
  try {
    const previous = new SourceStore(path);
    const original = previous.capture(request).source;
    previous.close();
    const fixture = new DatabaseSync(path);
    fixture.exec("DROP TABLE source_files; DROP TABLE source_metadata;");
    fixture.close();
    const upgraded = new SourceStore(path);
    try {
      assert.deepEqual(upgraded.find(original.id, request.scope), original);
      assert.deepEqual(upgraded.capture(request), {
        source: original,
        duplicate: true,
      });
      assert.deepEqual(upgraded.findMaterial(original.id, request.scope), {
        source: original,
        metadata: { type: "note" },
      });
      assert.deepEqual(upgraded.list(request.scope), [original]);
      assert.throws(() => upgraded.list(request.scope, 0));
      assert.throws(() => upgraded.list(request.scope, 21));
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata is immutable, scoped and part of persistent idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-material-retry-"));
  const path = join(directory, "context.db");
  try {
    let store = new SourceStore(path);
    const saved = store.captureMaterial(materialInput);
    assert.equal(saved.duplicate, false);
    assert.deepEqual(saved.material.metadata, materialInput.metadata);
    assert.notEqual(
      saved.material.source.capturedAt,
      saved.material.metadata.createdAt,
    );
    store.close();
    store = new SourceStore(path);
    try {
      assert.deepEqual(store.captureMaterial(materialInput), {
        material: saved.material,
        duplicate: true,
      });
      assert.throws(
        () =>
          store.captureMaterial({
            ...materialInput,
            metadata: { ...materialInput.metadata, title: "Changed title" },
          }),
        IdempotencyConflict,
      );
      assert.throws(
        () =>
          store.capture({
            version: 1,
            scope: materialInput.scope,
            text: materialInput.text,
            origin: materialInput.origin,
            idempotencyKey: materialInput.idempotencyKey,
          }),
        IdempotencyConflict,
      );
      assert.equal(
        store.findMaterial(saved.material.source.id, "synthetic:other"),
        undefined,
      );
      assert.deepEqual(store.list("synthetic:other"), []);
      assert.deepEqual(
        store.findMaterial(saved.material.source.id, materialInput.scope),
        saved.material,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file capture retains exact original UTF-8 bytes, BOM and line endings", () => {
  const store = new SourceStore(":memory:");
  try {
    const saved = store.captureFile(fileInput);
    assert.equal(
      saved.material.source.text,
      "\uFEFF# Synthetic moon\r\nSnow: ☃️\r\n",
    );
    assert.equal(saved.material.metadata.type, "document");
    assert.deepEqual(
      store.readMaterialFile(saved.material.source.id, fileInput.scope),
      {
        filename: "synthetic-moon.md",
        mediaType: "text/markdown",
        byteLength: 35,
        checksum:
          "43639f639b0966ba00f10420a94ff79492ec5e9010795cb0960ab035688b9570",
        contentBase64: fileInput.contentBase64,
      },
    );
    assert.deepEqual(store.captureFile(fileInput), {
      material: saved.material,
      duplicate: true,
    });
    assert.equal(
      store.readMaterialFile(saved.material.source.id, "synthetic:other"),
      undefined,
    );
    assert.equal(store.readMaterialFile("absent", fileInput.scope), undefined);
    assert.throws(
      () => store.captureFile({ ...fileInput, filename: "renamed.md" }),
      IdempotencyConflict,
    );
    assert.throws(
      () =>
        store.capture({
          version: 1,
          text: saved.material.source.text,
          origin: fileInput.origin,
          scope: fileInput.scope,
          idempotencyKey: fileInput.idempotencyKey,
        }),
      IdempotencyConflict,
    );
  } finally {
    store.close();
  }
});

test("invalid material input neither writes data nor consumes a request key", () => {
  const store = new SourceStore(":memory:");
  try {
    for (const contentBase64 of [
      "Zg",
      "Zg===",
      "Zh==",
      " Zg==",
      "AA==",
      "/w==",
      "wK8=",
      "IA==",
      Buffer.alloc(16385, "x").toString("base64"),
    ]) {
      assert.throws(() => store.captureFile({ ...fileInput, contentBase64 }));
    }
    for (const filename of [
      "../source.md",
      "a/thing.md",
      "a\\thing.md",
      "source.pdf",
      "a..md",
    ]) {
      assert.throws(() => store.captureFile({ ...fileInput, filename }));
    }
    assert.equal(
      captureFileSchema.safeParse({ ...fileInput, mediaType: "text/plain" })
        .success,
      false,
    );
    assert.throws(() =>
      store.captureFile({ ...fileInput, metadata: { type: "note" } }),
    );
    assert.throws(() =>
      store.captureMaterial({
        ...materialInput,
        metadata: { createdAt: "yesterday" },
      }),
    );
    assert.throws(() =>
      store.captureMaterial({
        ...materialInput,
        metadata: { sourceUri: "https://user:secret@example.com/" },
      }),
    );
    assert.throws(() =>
      store.captureMaterial({
        ...materialInput,
        metadata: { sourceUri: "https://example.com/\uD800" },
      }),
    );
    assert.throws(() =>
      store.captureMaterial({ ...materialInput, ...{ approved: true } }),
    );
    assert.throws(() =>
      store.captureFile({ ...fileInput, ...{ approved: true } }),
    );
    assert.deepEqual(store.list(fileInput.scope), []);
    assert.equal(store.captureFile(fileInput).duplicate, false);
    assert.equal(store.captureMaterial(materialInput).duplicate, false);
  } finally {
    store.close();
  }
});

test("file byte limit preserves all text at the boundary and rejects larger input", () => {
  const store = new SourceStore(":memory:");
  try {
    const contentBase64 = Buffer.alloc(16384, "x").toString("base64");
    const saved = store.captureFile({ ...fileInput, contentBase64 });
    assert.equal(saved.material.source.text.length, 16384);
    assert.equal(saved.material.file?.byteLength, 16384);
    assert.equal(
      store.readMaterialFile(saved.material.source.id, fileInput.scope)
        ?.contentBase64,
      contentBase64,
    );
    assert.throws(() =>
      store.captureFile({
        ...fileInput,
        idempotencyKey: "too-large",
        contentBase64: Buffer.alloc(16385, "x").toString("base64"),
      }),
    );
    assert.equal(store.list(fileInput.scope).length, 1);
  } finally {
    store.close();
  }
});

test("a failed original-file write rolls back source, metadata, FTS and retry key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-material-atomic-"));
  const path = join(directory, "context.db");
  const store = new SourceStore(path);
  const fixture = new DatabaseSync(path);
  try {
    fixture.exec(`
      CREATE TRIGGER fail_file BEFORE INSERT ON source_files BEGIN
        SELECT RAISE(ABORT, 'synthetic write failure');
      END;
    `);
    assert.throws(() => store.captureFile(fileInput));
    assert.deepEqual(store.list(fileInput.scope), []);
    assert.deepEqual(store.search("Synthetic moon", fileInput.scope, 10), []);
    fixture.exec("DROP TRIGGER fail_file;");
    const saved = store.captureFile(fileInput);
    assert.equal(saved.duplicate, false);
    assert.deepEqual(
      store.findMaterial(saved.material.source.id, fileInput.scope),
      saved.material,
    );
  } finally {
    fixture.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("online snapshot and offline restore retain original files, metadata, search and retry identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-material-recovery-"));
  const path = join(directory, "context.db");
  const snapshot = join(directory, "backup.db");
  const restored = join(directory, "restored.db");
  const original = new SourceStore(path);
  try {
    const saved = original.captureFile(fileInput).material;
    const note = original.captureMaterial(materialInput).material;
    await backupDatabase(path, snapshot);
    await restoreDatabase(snapshot, restored);
    const recovered = new SourceStore(restored);
    try {
      assert.deepEqual(
        recovered.findMaterial(saved.source.id, fileInput.scope),
        saved,
      );
      assert.deepEqual(
        recovered.findMaterial(note.source.id, materialInput.scope),
        note,
      );
      assert.equal(
        recovered.readMaterialFile(saved.source.id, fileInput.scope)
          ?.contentBase64,
        fileInput.contentBase64,
      );
      assert.deepEqual(
        recovered.search("Synthetic moon", fileInput.scope, 10),
        [saved.source],
      );
      assert.deepEqual(recovered.captureFile(fileInput), {
        material: saved,
        duplicate: true,
      });
      assert.deepEqual(recovered.captureMaterial(materialInput), {
        material: note,
        duplicate: true,
      });
    } finally {
      recovered.close();
    }
  } finally {
    original.close();
    await rm(directory, { recursive: true, force: true });
  }
});
