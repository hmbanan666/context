import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { maxImportTextLength } from "../src/import-format.js";
import { importMarkdown, splitMarkdownBody } from "../src/import-markdown.js";
import { SourceStore } from "../src/store.js";
import { buildContextPackage } from "../src/context-package.js";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { buildMemoryContext } from "../src/memory.js";

test("markdown chunks stay inside the source text limit", () => {
  const text = `${"alpha ".repeat(1600)}omega-terminus`;
  assert.ok(text.length > maxImportTextLength);
  const parts = splitMarkdownBody(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= maxImportTextLength));
  assert.equal(parts.join(""), text);
  assert.match(parts.at(-1) ?? "", /omega-terminus/);
});

test("markdown import is idempotent, updates revisions, and links a project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-md-"));
  const databasePath = join(directory, "context.db");
  const folder = join(directory, "notes");
  await mkdir(join(folder, "cases"), { recursive: true });
  const note = join(folder, "cases", "lantern.md");
  const body = `---
title: Lantern
project: mira
date: 2021-06-01
tags: [case, night]
---

# Lantern

The amber index glows. password="fictional-secret-value"
`;
  await writeFile(note, body);
  await writeFile(
    join(folder, "empty.md"),
    "---\nunknown: true\n---\n\n# Skip\n\nNope.\n",
  );
  const store = new SourceStore(databasePath);
  const knowledge = new KnowledgeStore(databasePath);
  try {
    store.createProject({
      id: "mira",
      name: "Mira Quill",
      homeArea: "studio",
    });
    const first = await importMarkdown(store, folder, {
      areas: ["studio"],
      area: "studio",
    });
    assert.equal(first.added, 1);
    assert.equal(first.rejected, 1);
    assert.equal(first.skipped, 0);
    const again = await importMarkdown(store, folder, {
      areas: ["studio"],
      area: "studio",
    });
    assert.equal(again.skipped, 1);
    assert.equal(again.added, 0);
    const source = store.list("studio")[0];
    assert.ok(source);
    assert.equal(source.text.includes("fictional-secret-value"), false);
    assert.equal(store.linkedToProject("source", source.id, "mira"), true);
    assert.equal(
      store.findMaterial(source.id, "studio")?.metadata.title,
      "Lantern",
    );
    assert.match(
      store.findMaterial(source.id, "studio")?.metadata.createdAt ?? "",
      /^2021-06-01T00:00:00(\.000)?Z$/,
    );
    assert.equal(
      store.findMaterial(source.id, "studio")?.import?.metadata.tags,
      "case,night",
    );
    assert.equal(
      store.findMaterial(source.id, "studio")?.import?.externalId,
      "cases/lantern.md",
    );
    await writeFile(note, body.replace("glows", "dims"));
    const updated = await importMarkdown(store, folder, {
      areas: ["studio"],
      area: "studio",
    });
    assert.equal(updated.updated, 1);
    assert.equal(updated.skipped, 0);
    const found = buildContextPackage(
      store,
      knowledge,
      { version: 1, scope: "studio", question: "amber index", limit: 5 },
      undefined,
      "mira",
    );
    assert.notEqual(found.grounding, "none");
    assert.match(
      found.sources.map((card) => card.excerpt.text).join("\n"),
      /dims/,
    );
  } finally {
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("markdown CLI reports added, skipped and updated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-md-cli-"));
  const databasePath = join(directory, "context.db");
  const folder = join(directory, "site");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "about.md");
  const text = "# About\n\nMira Quill keeps the Brassharbor desk.\n";
  await writeFile(file, text);
  const large = join(folder, "long.md");
  await writeFile(large, `${"beta ".repeat(2000)}end-marker`);
  const env = {
    ...process.env,
    CONTEXT_DB_PATH: databasePath,
    CONTEXT_AREAS: "studio",
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
    });
  try {
    const store = new SourceStore(databasePath);
    store.createProject({ id: "mira", name: "Mira Quill", homeArea: "studio" });
    store.close();
    const first = run([
      "import",
      "markdown",
      folder,
      "--area",
      "studio",
      "--project",
      "mira",
    ]);
    assert.equal(first.status, 0, first.stderr);
    const lines = first.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = lines.at(-1);
    assert.equal(summary.added, 3);
    assert.equal(summary.updated, 0);
    assert.equal(summary.skipped, 0);
    const second = run([
      "import",
      "markdown",
      folder,
      "--area",
      "studio",
      "--project",
      "mira",
    ]);
    assert.equal(second.status, 0, second.stderr);
    const skipped = JSON.parse(second.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(skipped.skipped, 3);
    await writeFile(file, text.replace("desk", "table"));
    const third = run([
      "import",
      "markdown",
      folder,
      "--area",
      "studio",
      "--project",
      "mira",
    ]);
    assert.equal(third.status, 0, third.stderr);
    const changed = JSON.parse(third.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(changed.updated, 1);
    assert.equal(changed.skipped, 2);
    const opened = new SourceStore(databasePath);
    try {
      const texts = opened.list("studio").map((source) => source.text);
      assert.ok(texts.some((value) => value.includes("end-marker")));
      assert.ok(texts.every((value) => value.length <= maxImportTextLength));
    } finally {
      opened.close();
    }
    const jobs = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const queued = Number(
        jobs.prepare("SELECT COUNT(*) n FROM embedding_jobs").get()?.n,
      );
      assert.ok(queued >= 3);
    } finally {
      jobs.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prune retires missing paths and doc remove hides one record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-md-prune-"));
  const databasePath = join(directory, "context.db");
  const folder = join(directory, "notes");
  const otherFolder = join(directory, "other");
  await mkdir(join(folder, "cases"), { recursive: true });
  await mkdir(otherFolder, { recursive: true });
  const gone = join(folder, "cases", "gone.md");
  const kept = join(folder, "keep.md");
  const adr = join(folder, "adr.md");
  const long = join(folder, "long.md");
  await writeFile(gone, "# Gone\n\nThe missing lantern left the folder.\n");
  await writeFile(kept, "# Keep\n\nThe brass harbor desk stays.\n");
  await writeFile(
    adr,
    `---
type: adr
key: "0012"
status: accepted
title: Amber index
---

# Amber index

The amber index stays on the desk.
`,
  );
  await writeFile(long, `${"beta ".repeat(2000)}end-marker-prune`);
  await writeFile(
    join(otherFolder, "blue.md"),
    "# Blue\n\nThe cobalt slip stays.\n",
  );
  const store = new SourceStore(databasePath);
  const knowledge = new KnowledgeStore(databasePath);
  const index = new EmbeddingIndex(databasePath, {
    version: "fixture-retire",
    async embed() {
      return Float32Array.from([1, 0]);
    },
  });
  try {
    store.createProject({ id: "mira", name: "Mira Quill", homeArea: "studio" });
    store.createProject({ id: "other", name: "Other", homeArea: "studio" });
    const options = {
      areas: ["studio"],
      area: "studio",
      project: "mira",
    };
    await importMarkdown(store, folder, options);
    await importMarkdown(store, otherFolder, {
      ...options,
      project: "other",
    });
    assert.equal(store.search("missing lantern", "studio", 5).length, 1);
    assert.ok(store.resolveDocument("doc:mira:adr:0012", "studio"));
    const goneId = store
      .list("studio", 20)
      .find((source) => source.text.includes("missing lantern"))?.id;
    assert.ok(goneId);
    const vector = Buffer.alloc(8);
    vector.writeFloatLE(1, 0);
    const sql = new DatabaseSync(databasePath);
    sql
      .prepare(
        `INSERT INTO embedding_chunks
          (kind, record_id, scope, chunk, offset, model, vector)
         VALUES ('sources', ?, 'studio', 0, 0, 'fixture-retire', ?)`,
      )
      .run(goneId, vector);
    sql.close();
    const before = await index.search({
      scope: "studio",
      question: "missing lantern",
    });
    assert.ok(before.sources.some((hit) => hit.id === goneId));
    await rm(gone);
    await rm(adr);
    await rm(long);
    const keptVisible = await importMarkdown(store, folder, options);
    assert.equal(keptVisible.removed, 0);
    assert.equal(store.search("missing lantern", "studio", 5).length, 1);
    const pruned = await importMarkdown(store, folder, {
      ...options,
      prune: true,
    });
    assert.ok(pruned.removed >= 4);
    assert.equal(store.search("missing lantern", "studio", 5).length, 0);
    assert.equal(store.search("end-marker-prune", "studio", 5).length, 0);
    assert.equal(store.search("amber index", "studio", 5).length, 0);
    assert.equal(store.search("brass harbor", "studio", 5).length, 1);
    assert.equal(store.search("cobalt slip", "studio", 5).length, 1);
    assert.equal(store.find(goneId, "studio"), undefined);
    assert.equal(
      store.resolveDocument("doc:mira:adr:0012", "studio"),
      undefined,
    );
    const timeline = buildMemoryContext(store, {
      version: 1,
      scope: "studio",
      limit: 20,
    });
    assert.equal(
      timeline.sources.some((item) =>
        item.source.text.includes("missing lantern"),
      ),
      false,
    );
    const after = await index.search({
      scope: "studio",
      question: "missing lantern",
    });
    assert.equal(
      after.sources.some((hit) => hit.id === goneId),
      false,
    );
    const history = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const text = String(
        history.prepare("SELECT text FROM sources WHERE id = ?").get(goneId)
          ?.text,
      );
      assert.match(text, /missing lantern/);
      const tomb = history
        .prepare("SELECT reason FROM source_retirements WHERE source_id = ?")
        .get(goneId);
      assert.equal(tomb?.reason, "import_prune");
      assert.equal(JSON.stringify(tomb).includes("lantern"), false);
    } finally {
      history.close();
    }
    const again = await importMarkdown(store, folder, {
      ...options,
      prune: true,
    });
    assert.equal(again.removed, 0);
    await writeFile(gone, "# Gone\n\nThe missing lantern left the folder.\n");
    await importMarkdown(store, folder, { ...options, prune: true });
    assert.equal(store.search("missing lantern", "studio", 5).length, 1);
    await writeFile(
      adr,
      `---
type: adr
key: "0012"
status: accepted
title: Amber index
---

# Amber index

The amber index stays on the desk.
`,
    );
    await importMarkdown(store, folder, options);
    assert.ok(store.resolveDocument("doc:mira:adr:0012", "studio"));
    const removedDoc = store.removeRecord("doc:mira:adr:0012");
    assert.equal(removedDoc?.id, "doc:mira:adr:0012");
    assert.ok((removedDoc?.removed ?? 0) >= 1);
    assert.equal(
      store.resolveDocument("doc:mira:adr:0012", "studio"),
      undefined,
    );
    assert.equal(store.search("amber index", "studio", 5).length, 0);
    assert.equal(store.removeRecord("doc:mira:adr:0012")?.removed, 0);
    const restoredDoc = store.restoreRecord("doc:mira:adr:0012");
    assert.equal(restoredDoc?.id, "doc:mira:adr:0012");
    assert.ok((restoredDoc?.restored ?? 0) >= 1);
    assert.ok(store.resolveDocument("doc:mira:adr:0012", "studio"));
    assert.equal(store.restoreRecord("doc:mira:adr:0012")?.restored, 0);
    assert.equal(store.removeRecord("doc:mira:adr:0012")?.removed, 1);
    assert.equal(store.restoreRecord("missing-source"), undefined);
    const keptId = store
      .list("studio", 20)
      .find((source) => source.text.includes("brass harbor"))?.id;
    assert.ok(keptId);
    assert.equal(store.removeRecord(keptId)?.removed, 1);
    assert.equal(store.find(keptId, "studio"), undefined);
    assert.equal(store.search("brass harbor", "studio", 5).length, 0);
    assert.equal(store.removeRecord("missing-source"), undefined);
    const pack = buildContextPackage(
      store,
      knowledge,
      { version: 1, scope: "studio", question: "cobalt slip", limit: 5 },
      undefined,
      "other",
    );
    assert.match(
      pack.sources.map((card) => card.excerpt.text).join("\n"),
      /cobalt/,
    );
  } finally {
    await index.close();
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("prune does not retire a different import root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-md-root-"));
  const databasePath = join(directory, "context.db");
  const folderA = join(directory, "a");
  const folderB = join(directory, "b");
  await mkdir(folderA, { recursive: true });
  await mkdir(folderB, { recursive: true });
  await writeFile(
    join(folderA, "keep.md"),
    "# Keep\n\nAmber stays in folder A.\n",
  );
  await writeFile(
    join(folderB, "blue.md"),
    "# Blue\n\nCobalt stays in folder B.\n",
  );
  const store = new SourceStore(databasePath);
  try {
    store.createProject({ id: "mira", name: "Mira Quill", homeArea: "studio" });
    const shared = { areas: ["studio"], area: "studio", project: "mira" };
    await importMarkdown(store, folderA, shared);
    await importMarkdown(store, folderB, shared);
    await rm(join(folderB, "blue.md"));
    await assert.rejects(
      () => importMarkdown(store, folderB, { ...shared, prune: true }),
      /Refusing to prune an empty folder/,
    );
    assert.equal(store.search("Amber stays", "studio", 5).length, 1);
    assert.equal(store.search("Cobalt stays", "studio", 5).length, 1);
    const pruned = await importMarkdown(store, folderB, {
      ...shared,
      prune: true,
      force: true,
    });
    assert.equal(pruned.removed, 1);
    assert.equal(store.search("Amber stays", "studio", 5).length, 1);
    assert.equal(store.search("Cobalt stays", "studio", 5).length, 0);
    const sql = new DatabaseSync(databasePath);
    sql.exec("DELETE FROM markdown_import_roots");
    sql.close();
    const legacy = await importMarkdown(store, folderB, {
      ...shared,
      prune: true,
      force: true,
    });
    assert.equal(legacy.removed, 0);
    assert.equal(store.search("Amber stays", "studio", 5).length, 1);
    const opted = await importMarkdown(store, folderB, {
      ...shared,
      prune: true,
      pruneLegacy: true,
      force: true,
    });
    assert.equal(opted.removed, 1);
    assert.equal(store.search("Amber stays", "studio", 5).length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("markdown CLI prune and doc remove", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-md-prune-cli-"));
  const databasePath = join(directory, "context.db");
  const folder = join(directory, "site");
  await mkdir(folder, { recursive: true });
  const gone = join(folder, "gone.md");
  const kept = join(folder, "keep.md");
  await writeFile(gone, "# Gone\n\nThe retired page should leave search.\n");
  await writeFile(kept, "# Keep\n\nThe remaining page stays.\n");
  const env = {
    ...process.env,
    CONTEXT_DB_PATH: databasePath,
    CONTEXT_AREAS: "studio",
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
    });
  try {
    const store = new SourceStore(databasePath);
    store.createProject({ id: "mira", name: "Mira Quill", homeArea: "studio" });
    store.close();
    const first = run([
      "import",
      "markdown",
      folder,
      "--area",
      "studio",
      "--project",
      "mira",
    ]);
    assert.equal(first.status, 0, first.stderr);
    const lines = first.stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            path?: string;
            source_id?: string;
            removed?: number;
          },
      );
    assert.equal(lines.at(-1)?.removed, 0);
    const keptId = lines.find((line) => line.path === "keep.md")?.source_id;
    assert.ok(keptId);
    await rm(gone);
    const pruned = run([
      "import",
      "markdown",
      folder,
      "--area",
      "studio",
      "--project",
      "mira",
      "--prune",
    ]);
    assert.equal(pruned.status, 0, pruned.stderr);
    const summary = JSON.parse(pruned.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(summary.removed, 1);
    assert.equal(summary.skipped, 1);
    const removed = run(["doc", "remove", keptId]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).removed, 1);
    assert.equal(JSON.parse(removed.stdout).id, keptId);
    const opened = new SourceStore(databasePath);
    try {
      assert.equal(opened.search("retired page", "studio", 5).length, 0);
      assert.equal(opened.search("remaining page", "studio", 5).length, 0);
      assert.equal(opened.find(keptId, "studio"), undefined);
    } finally {
      opened.close();
    }
    const restored = run(["doc", "restore", keptId]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).restored, 1);
    assert.equal(JSON.parse(restored.stdout).id, keptId);
    const again = run(["source", "restore", keptId]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).restored, 0);
    const visible = new SourceStore(databasePath);
    try {
      assert.equal(visible.search("remaining page", "studio", 5).length, 1);
      assert.ok(visible.find(keptId, "studio"));
    } finally {
      visible.close();
    }
    const missingFolder = run([
      "import",
      "markdown",
      join(directory, "missing-notes"),
      "--area",
      "studio",
      "--project",
      "mira",
      "--prune",
    ]);
    assert.equal(missingFolder.status, 1);
    assert.match(missingFolder.stderr, /Refusing to prune a missing folder/);
    assert.equal(missingFolder.stdout.trim(), "");
    const missing = run(["doc", "remove", "missing-source"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Not found/);
    const usage = run(["doc"]);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /doc remove/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
