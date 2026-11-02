import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { openPackageFixture } from "./fixtures/package-client.js";

test("JSONL imports survive reopen, skip retries, preserve changed originals and are found through MCP", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output-import-"));
  const path = join(directory, "context.db");
  const run = (input: string) =>
    spawnSync(
      process.execPath,
      [
        "dist/scripts/context.js",
        "import",
        "jsonl",
        "--source",
        "grokbot",
        "--area",
        "personal",
      ],
      {
        env: {
          ...process.env,
          CONTEXT_DB_PATH: path,
          CONTEXT_AREAS: "personal,projects,inbox",
        },
        encoding: "utf8",
        input,
      },
    );
  const line = {
    id: "note:1",
    text: "The fictional cobalt telescope has three rings.",
    title: "Telescope",
    created_at: "2026-01-01T12:00:00Z",
    url: "https://example.org/notes/1",
    kind: "decision",
    metadata: { topic: "astronomy" },
  };
  try {
    const first = run(`${JSON.stringify(line)}\n`);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      JSON.parse(first.stdout.split("\n")[0] ?? "").status,
      "created",
    );
    assert.equal(
      JSON.parse(run(JSON.stringify(line)).stdout.split("\n")[0] ?? "").status,
      "skipped",
    );
    const changed = run(
      JSON.stringify({
        ...line,
        text: "A different interpretation.",
        area: "projects",
      }),
    );
    assert.equal(changed.status, 0);
    assert.equal(
      JSON.parse(changed.stdout.split("\n")[0] ?? "").status,
      "changed",
    );
    assert.equal(
      JSON.parse(
        run(
          JSON.stringify({
            ...line,
            text: "A different interpretation.",
            area: "projects",
          }),
        ).stdout.split("\n")[0] ?? "",
      ).status,
      "skipped",
    );
    assert.equal(
      JSON.parse(run(JSON.stringify(line)).stdout.split("\n")[0] ?? "").status,
      "skipped",
    );
    const f = await openPackageFixture(path);
    try {
      const client = await f.connect();
      const recalled = await client.callTool({
        name: "recall",
        arguments: { version: 1, scope: "personal", query: "cobalt telescope" },
      });
      assert.ok(!recalled.isError);
      assert.ok(JSON.stringify(recalled.structuredContent).includes(line.text));
      const packaged = await client.callTool({
        name: "context_package",
        arguments: { question: "cobalt telescope", scope: "personal" },
      });
      assert.ok(!packaged.isError);
      assert.ok(
        JSON.stringify(packaged.structuredContent).includes("three rings"),
      );
      const source = f.store.list("personal")[0];
      assert.ok(source);
      assert.equal(f.store.list("personal").length, 1);
      assert.equal(f.store.list("projects").length, 1);
      const revision = f.store.list("projects")[0];
      assert.ok(revision);
      assert.equal(revision.text, "A different interpretation.");
      assert.equal(
        f.store.findMaterial(revision.id, "projects")?.import?.externalId,
        line.id,
      );
      const denied = await client.callTool({
        name: "recall",
        arguments: { version: 1, scope: "projects", id: revision.id },
      });
      assert.ok(denied.isError);
      assert.equal(source.text, line.text);
      const material = f.store.findMaterial(source.id, "personal");
      assert.equal(material?.metadata.sourceUri, line.url);
      assert.ok(JSON.stringify(material).includes('"externalId":"note:1"'));
    } finally {
      await f.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports redact every retained field, isolate bad lines and route unknown areas safely", async () => {
  const { importJsonl } = await import("../src/imports.js");
  const { SourceStore } = await import("../src/store.js");
  const { readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(process.cwd(), ".output-import-"));
  const path = join(directory, "context.db");
  const store = new SourceStore(path);
  const fake = `ghp_${"a".repeat(36)}`;
  const item = {
    id: "secret-test",
    text: `Fictional token ${fake} password="fake secret value"`,
    title: fake,
    kind: "note",
    area: "unknown",
    url: `https://example.org/?token=${fake}`,
    metadata: { api_key: "fake-map-secret", info: fake },
  };
  try {
    const results: unknown[] = [];
    const input = [
      "not-json\n",
      `${"x".repeat(131073)}\n`,
      `${JSON.stringify(item)}\n`,
      `${JSON.stringify({ id: "next", text: "Valid next item", area: "projects" })}\n`,
      `${JSON.stringify({ id: "nested", text: "Bad", metadata: { nested: {} } })}\n`,
    ];
    const summary = await importJsonl(
      store,
      (async function* () {
        yield* input;
      })(),
      {
        source: "synthetic",
        area: "personal",
        areas: ["personal", "projects", "inbox"],
      },
      (r) => {
        results.push(r);
      },
    );
    assert.deepEqual(summary, {
      type: "summary",
      created: 2,
      skipped: 0,
      changed: 0,
      rejected: 3,
    });
    assert.equal(store.list("inbox").length, 1);
    assert.equal(store.list("projects").length, 1);
    const source = store.list("inbox")[0];
    assert.ok(source);
    const material = JSON.stringify(store.findMaterial(source.id, "inbox"));
    for (const secret of [fake, "fake secret value", "fake-map-secret"])
      assert.ok(!material.includes(secret));
    assert.ok(material.includes("[REDACTED]"));
    assert.ok(!JSON.stringify(results).includes("Fictional"));
    const withoutInbox = await importJsonl(
      store,
      (async function* () {
        yield JSON.stringify({ ...item, id: "no-inbox" });
      })(),
      { source: "synthetic", areas: ["personal"] },
      () => {},
    );
    assert.equal(withoutInbox.rejected, 1);
  } finally {
    store.close();
  }
  try {
    const bytes = await readFile(path);
    for (const secret of [fake, "fake secret value", "fake-map-secret"])
      assert.ok(!bytes.includes(Buffer.from(secret)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("import identity is global per source, metadata order is irrelevant, and malformed UTF-8 cannot corrupt following records", async () => {
  const { importJsonl } = await import("../src/imports.js");
  const { SourceStore } = await import("../src/store.js");
  const store = new SourceStore(":memory:");
  const run = (value: unknown, source = "fixture", area = "personal") =>
    importJsonl(
      store,
      (async function* () {
        yield JSON.stringify(value);
      })(),
      { source, area, areas: ["personal", "projects"] },
      () => {},
    );
  const item = {
    id: "same",
    text: "Original telescope report",
    metadata: { a: "one", b: "two" },
  };
  try {
    assert.equal((await run(item)).created, 1);
    assert.equal(
      (await run({ ...item, metadata: { b: "two", a: "one" } })).skipped,
      1,
    );
    assert.equal((await run(item, "fixture", "projects")).changed, 1);
    assert.equal((await run(item, "another")).created, 1);
    const results: unknown[] = [];
    const summary = await importJsonl(
      store,
      (async function* () {
        yield Buffer.from([0xff, 0x0a]);
        const bytes = Buffer.from(
          `${JSON.stringify({ id: "unicode", text: "Тelescope 🔭" })}\r\n`,
        );
        for (const byte of bytes) yield Buffer.from([byte]);
        yield JSON.stringify({
          id: `ghp_${"c".repeat(36)}`,
          text: "Unsafe id",
        });
      })(),
      { source: "fixture", area: "personal", areas: ["personal"] },
      (r) => {
        results.push(r);
      },
    );
    assert.equal(summary.created, 1);
    assert.equal(summary.rejected, 2);
    assert.ok(JSON.stringify(results).includes("unsafe_identity"));
    assert.equal(
      store.search("Тelescope", "personal", 10)[0]?.text,
      "Тelescope 🔭",
    );
  } finally {
    store.close();
  }
});

test("concurrent file imports create one revision per version and restored retries skip both versions", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const { backupDatabase, restoreDatabase } = await import("../src/backup.js");
  const { SourceStore } = await import("../src/store.js");
  const directory = await mkdtemp(join(process.cwd(), ".output-import-"));
  const path = join(directory, "context.db");
  const file = join(directory, "synthetic.jsonl");
  const exec = promisify(execFile);
  const run = (db: string) =>
    exec(
      process.execPath,
      [
        "dist/scripts/context.js",
        "import",
        "jsonl",
        "--source",
        "fixture",
        "--area",
        "projects",
        "--file",
        file,
      ],
      {
        env: { ...process.env, CONTEXT_DB_PATH: db, CONTEXT_AREAS: "projects" },
      },
    );
  try {
    // Create the normal schema before exercising competing import transactions.
    new SourceStore(path).close();
    await writeFile(
      file,
      [
        { id: "one", text: "Original telescope" },
        { id: "one", text: "Revised telescope" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const runs = await Promise.all([run(path), run(path)]);
    const statuses = runs
      .flatMap((r) =>
        r.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      .filter((r) => r.type === "item")
      .map((r) => r.status)
      .sort();
    assert.deepEqual(statuses, ["changed", "created", "skipped", "skipped"]);
    const snapshot = join(directory, "snapshot.db");
    const restored = join(directory, "restored.db");
    await backupDatabase(path, snapshot);
    await restoreDatabase(snapshot, restored);
    const retried = await run(restored);
    assert.deepEqual(
      JSON.parse(retried.stdout.trim().split("\n").at(-1) ?? ""),
      { type: "summary", created: 0, skipped: 2, changed: 0, rejected: 0 },
    );
    const store = new SourceStore(restored);
    try {
      const sources = store.list("projects");
      assert.equal(sources.length, 2);
      assert.ok(
        sources.every(
          (s) =>
            store.findMaterial(s.id, "projects")?.import?.externalId === "one",
        ),
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
