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
import { KnowledgeStore } from "../src/knowledge.js";

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
