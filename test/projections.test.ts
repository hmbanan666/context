import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../src/knowledge.js";
import {
  buildProjectContext,
  projectContextSchema,
} from "../src/projections.js";
import { SourceStore } from "../src/store.js";

const scope = "synthetic:project-a";
const creator = {
  kind: "model" as const,
  name: "synthetic-extractor",
  version: "fixture-1",
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "context-projection-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  return { directory, path, sources, knowledge };
}

test("empty context uses bounded defaults and rejects fields that could imply project grants", async () => {
  const f = await fixture();
  try {
    const context = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
    });
    assert.equal(context.version, 1);
    assert.equal(context.scope, scope);
    assert.ok(Number.isFinite(Date.parse(context.generatedAt)));
    assert.deepEqual(context.sources, []);
    assert.deepEqual(context.items, []);
    assert.deepEqual(context.relations, []);
    assert.equal(context.truncated, false);
    assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 16384);
    for (const invalid of [
      { version: 1, scope, project: "project-b" },
      { version: 1, scope, grantedScopes: ["synthetic:project-b"] },
      { version: 1, scope, limit: 0 },
      { version: 1, scope, limit: 21 },
      { version: 1, scope, maxBytes: 1023 },
      { version: 1, scope, maxBytes: 65537 },
      { version: 1, scope: "private:project" },
    ])
      assert.equal(projectContextSchema.safeParse(invalid).success, false);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("one project context includes complete same-scope provenance and excludes another project's records", async () => {
  const f = await fixture();
  try {
    const own = f.sources.captureMaterial({
      version: 1,
      scope,
      text: "Synthetic project A uses a violet lamp.",
      origin: "fixture:projection-a",
      idempotencyKey: "a-1",
      metadata: { title: "Project A note" },
    }).material;
    const foreign = f.sources.capture({
      version: 1,
      scope: "synthetic:project-b",
      text: "Synthetic project B uses a green kite.",
      origin: "fixture:projection-b",
      idempotencyKey: "b-1",
    }).source;
    const item = f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "idea-a",
      kind: "idea",
      text: "Try the synthetic violet lamp.",
      sourceRefs: [{ sourceId: own.source.id, quote: "violet lamp" }],
      creator,
    }).item;
    const foreignItem = f.knowledge.add({
      version: 1,
      scope: foreign.scope,
      idempotencyKey: "idea-b",
      kind: "idea",
      text: "Synthetic secret green kite.",
      sourceRefs: [{ sourceId: foreign.id }],
      creator,
    }).item;
    const context = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
    });
    assert.deepEqual(context.sources, [own]);
    assert.deepEqual(context.items, [item]);
    assert.equal(context.truncated, false);
    assert.equal(JSON.stringify(context).includes(foreign.id), false);
    assert.equal(JSON.stringify(context).includes(foreignItem.id), false);
    assert.equal(JSON.stringify(context).includes("green kite"), false);
    const other = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope: foreign.scope,
    });
    assert.deepEqual(other.items, [foreignItem]);
    assert.equal(other.sources[0]?.source.id, foreign.id);
    assert.equal(JSON.stringify(other).includes(own.source.id), false);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("knowledge includes cited sources older than the bounded recent-source scan", async () => {
  const f = await fixture();
  try {
    const older = f.sources.insert({
      id: "old-source",
      scope,
      text: "Synthetic original violet lamp evidence.",
      origin: "fixture:old-source",
      capturedAt: "2000-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 25; index++) {
      f.sources.insert({
        id: `recent-${index}`,
        scope,
        text: `Synthetic recent note ${index}.`,
        origin: "fixture:recent-source",
        capturedAt: "2026-10-27T00:00:00.000Z",
      });
    }
    const item = f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "old-idea",
      kind: "observation",
      text: "The earlier synthetic source contains lamp evidence.",
      sourceRefs: [{ sourceId: older.id, quote: "violet lamp evidence" }],
      creator,
    }).item;
    const context = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
      limit: 1,
    });
    assert.deepEqual(context.items, [item]);
    assert.deepEqual(
      context.sources.find((entry) => entry.source.id === older.id)?.source,
      older,
    );
    assert.equal(context.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 16384);
    const again = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
      limit: 1,
    });
    assert.deepEqual({ ...again, generatedAt: context.generatedAt }, context);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a small item limit never removes any source required by a multi-source item", async () => {
  const f = await fixture();
  try {
    const first = f.sources.capture({
      version: 1,
      scope,
      text: "Synthetic first source.",
      origin: "fixture:multi-source",
      idempotencyKey: "multi-1",
    }).source;
    const second = f.sources.capture({
      version: 1,
      scope,
      text: "Synthetic second source.",
      origin: "fixture:multi-source",
      idempotencyKey: "multi-2",
    }).source;
    const item = f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "multi-idea",
      kind: "observation",
      text: "Both synthetic sources contribute evidence.",
      sourceRefs: [
        { sourceId: first.id, quote: "first source" },
        { sourceId: second.id, quote: "second source" },
      ],
      creator,
    }).item;
    const context = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
      limit: 1,
    });
    assert.deepEqual(context.items, [item]);
    assert.deepEqual(
      context.sources.map((entry) => entry.source.id),
      [first.id, second.id],
    );
    assert.equal(context.truncated, false);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("UTF-8 budget omits oversized knowledge and original sources as whole records", async () => {
  const f = await fixture();
  try {
    const largeText = "🧪".repeat(200);
    const large = f.sources.capture({
      version: 1,
      scope,
      text: largeText,
      origin: "fixture:unicode-source",
      idempotencyKey: "unicode-large",
    }).source;
    f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "unicode-idea",
      kind: "idea",
      text: "A synthetic idea requires the full original source.",
      sourceRefs: [{ sourceId: large.id, quote: "🧪" }],
      creator,
    });
    const standaloneEnvelope = {
      version: 1,
      scope,
      generatedAt: new Date().toISOString(),
      sources: [f.sources.findMaterial(large.id, scope)],
      items: [],
      relations: [],
      truncated: false,
    };
    assert.ok(JSON.stringify(standaloneEnvelope).length < 1024);
    assert.ok(
      Buffer.byteLength(JSON.stringify(standaloneEnvelope), "utf8") > 1024,
    );
    const small = f.sources.capture({
      version: 1,
      scope,
      text: "Synthetic small fallback source.",
      origin: "fixture:small-source",
      idempotencyKey: "small",
    }).source;
    const context = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
      maxBytes: 1024,
    });
    assert.deepEqual(context.items, []);
    assert.deepEqual(
      context.sources.map((entry) => entry.source),
      [small],
    );
    assert.equal(context.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 1024);
    assert.equal(JSON.stringify(context).includes(large.id), false);
    assert.deepEqual(f.sources.find(large.id, scope), large);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("relations are emitted only with both endpoints and all original source evidence", async () => {
  const f = await fixture();
  try {
    const first = f.sources.capture({
      version: 1,
      scope,
      text: "Synthetic violet lamp evidence.",
      origin: "fixture:first",
      idempotencyKey: "first",
    }).source;
    const second = f.sources.capture({
      version: 1,
      scope,
      text: "Synthetic comparison supports the lamp experiment.",
      origin: "fixture:second",
      idempotencyKey: "second",
    }).source;
    const oldRelationSource = f.sources.insert({
      id: "old-relation-source",
      scope,
      text: "Synthetic comparison ledger: both observations support a trial.",
      origin: "fixture:relation",
      capturedAt: "1999-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 25; index++) {
      f.sources.insert({
        id: `relation-recent-${index}`,
        scope,
        text: `Synthetic recent relation note ${index}.`,
        origin: "fixture:relation-recent",
        capturedAt: "2026-10-27T00:00:00.000Z",
      });
    }
    const a = f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "knowledge-a",
      kind: "observation",
      text: "Synthetic observation A.",
      sourceRefs: [{ sourceId: first.id }],
      creator,
    }).item;
    const b = f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "knowledge-b",
      kind: "idea",
      text: "Synthetic idea B.",
      sourceRefs: [{ sourceId: second.id }],
      creator,
    }).item;
    const relation = f.knowledge.relate({
      version: 1,
      scope,
      idempotencyKey: "link-a-b",
      kind: "supports",
      fromId: a.id,
      toId: b.id,
      sourceRefs: [
        { sourceId: oldRelationSource.id, quote: "support a trial" },
      ],
      creator,
    }).relation;
    const full = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
      limit: 2,
    });
    assert.deepEqual(full.relations, [relation]);
    assert.equal(full.items.length, 2);
    assert.equal(
      full.sources.some((entry) => entry.source.id === oldRelationSource.id),
      true,
    );
    for (const item of full.items) {
      for (const ref of item.sourceRefs)
        assert.ok(
          full.sources.some((entry) => entry.source.id === ref.sourceId),
        );
    }
    for (const ref of relation.sourceRefs)
      assert.ok(full.sources.some((entry) => entry.source.id === ref.sourceId));
    const limited = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
      limit: 1,
    });
    assert.equal(limited.items.length, 1);
    assert.deepEqual(limited.relations, []);
    assert.equal(limited.truncated, true);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("file materials include descriptors without original file transfer payloads", async () => {
  const f = await fixture();
  try {
    const captured = f.sources.captureFile({
      version: 1,
      scope,
      idempotencyKey: "file-a",
      origin: "fixture:file",
      filename: "synthetic.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from(
        "Synthetic file with violet lamp evidence.",
      ).toString("base64"),
    });
    const context = buildProjectContext(f.sources, f.knowledge, {
      version: 1,
      scope,
    });
    assert.deepEqual(context.sources, [captured.material]);
    assert.equal(context.sources[0]?.file?.filename, "synthetic.txt");
    assert.equal(JSON.stringify(context).includes("contentBase64"), false);
  } finally {
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("unavailable provenance excludes the entire derived record", async () => {
  const f = await fixture();
  class UnavailableSources extends SourceStore {
    override findMaterial(): undefined {
      return undefined;
    }
  }
  const unavailable = new UnavailableSources(f.path);
  try {
    const source = f.sources.capture({
      version: 1,
      scope,
      text: "Synthetic evidence currently unavailable.",
      origin: "fixture:missing",
      idempotencyKey: "missing",
    }).source;
    f.knowledge.add({
      version: 1,
      scope,
      idempotencyKey: "missing-idea",
      kind: "idea",
      text: "Synthetic dependent idea.",
      sourceRefs: [{ sourceId: source.id }],
      creator,
    });
    const context = buildProjectContext(unavailable, f.knowledge, {
      version: 1,
      scope,
    });
    assert.deepEqual(context.sources, []);
    assert.deepEqual(context.items, []);
    assert.deepEqual(context.relations, []);
    assert.equal(context.truncated, true);
  } finally {
    unavailable.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
