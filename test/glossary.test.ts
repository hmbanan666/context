import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { EmbeddingIndex } from "../src/embedding-index.js";
import { e5Prefixed } from "../src/embedding-model.js";
import { expandQueryTerms, builtinGlossary } from "../src/glossary.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

test("E5 prefixes keep the required space", () => {
  assert.equal(
    e5Prefixed("query", "улучшить ночную дистилляцию"),
    "query: улучшить ночную дистилляцию",
  );
  assert.equal(e5Prefixed("passage", "nightly tidy"), "passage: nightly tidy");
});

test("glossary expansion follows stems and drops terms already in the query", () => {
  const expanded = expandQueryTerms(
    ["улучшить", "ночную", "дистилляцию"],
    builtinGlossary,
  );
  assert.deepEqual(expanded, ["nightly", "distill", "distillation"]);
  assert.deepEqual(
    expandQueryTerms(
      ["бэкап"],
      [...builtinGlossary, { term: "дистилляция", synonyms: ["tidy"] }],
    ).includes("tidy"),
    false,
  );
  const overridden = expandQueryTerms(
    ["дистилляцию"],
    [
      ...builtinGlossary.filter((entry) => entry.term !== "дистилляция"),
      { term: "дистилляция", synonyms: ["tidy"] },
    ],
  );
  assert.deepEqual(overridden, ["tidy"]);
});

async function open(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `context-${name}-`));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  sources.createProject({
    id: "context",
    name: "Context",
    homeArea: "projects",
  });
  return { directory, path, sources, knowledge };
}

function decision(
  sources: SourceStore,
  knowledge: KnowledgeStore,
  key: string,
  text: string,
) {
  const source = sources.captureMaterial(
    {
      version: 1,
      scope: "projects",
      origin: "synthetic:glossary",
      idempotencyKey: key,
      text,
      metadata: { createdAt: "2026-11-02T00:00:00.000Z" },
    },
    undefined,
    ["context"],
  ).material.source;
  return knowledge.addDistilled({
    scope: "projects",
    sourceId: source.id,
    kind: "decision",
    text,
    createdAt: "2026-11-02T00:00:00.000Z",
  }).item;
}

test("project glossary is owner-editable and a Russian task outranks the backup neighbour", async () => {
  const f = await open("glossary-rank");
  const embedder = {
    version: "synthetic-glossary-v1",
    async embed(text: string, purpose: "query" | "passage") {
      if (purpose === "query" || text.includes("off-host backups"))
        return Float32Array.from([1, 0, 0, 0]);
      return Float32Array.from([0, 1, 0, 0]);
    },
  };
  const index = new EmbeddingIndex(f.path, embedder);
  const directory = f.directory;
  try {
    decision(
      f.sources,
      f.knowledge,
      "adr",
      "ADR-0011 nightly tidy distills each source into a short proposed fact.",
    );
    decision(
      f.sources,
      f.knowledge,
      "backup",
      "Nightly off-host backups copy a SQLite snapshot to S3 or SFTP.",
    );
    decision(
      f.sources,
      f.knowledge,
      "tidy-only",
      "The tidy pass finished the fictional lane.",
    );
    f.sources.setGlossaryTerm({
      projectId: "context",
      term: "дистилляция",
      synonyms: ["distill", "distillation", "tidy"],
    });
    await index.reindexEmbeddings(4, () => {});
    const mcp = createContextMcp(f.sources, ["projects"], false, {
      knowledge: f.knowledge,
      embeddings: index,
    });
    const client = new Client({ name: "glossary-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (input, init) => mcp.fetch(new Request(input, init)),
      }),
    );
    try {
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
        ["read", "remember", "search", "timeline"],
      );
      const pack = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          mode: "pack",
          query: "улучшить ночную дистилляцию",
          budgetBytes: 4096,
        },
      });
      assert.equal(pack.isError, false);
      const texts = (
        pack.structuredContent as { items: { excerpt: { text: string } }[] }
      ).items.map((item) => item.excerpt.text);
      const distill = texts.findIndex((text) =>
        text.includes("distills each source"),
      );
      const backup = texts.findIndex((text) =>
        text.includes("off-host backups"),
      );
      assert.ok(distill >= 0, texts.join("\n"));
      assert.ok(backup > distill, texts.join("\n"));
      const tidy = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          query: "дистилляция",
          k: 10,
        },
      });
      assert.ok(
        JSON.stringify(tidy.structuredContent).includes("tidy pass finished"),
      );
    } finally {
      await client.close();
      await mcp.close();
    }
  } finally {
    await index.close();
    f.knowledge.close();
    f.sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an original term outranks a two-synonym English neighbour", async () => {
  const f = await open("glossary-original");
  const embedder = {
    version: "synthetic-glossary-v2",
    async embed(text: string, purpose: "query" | "passage") {
      if (purpose === "query" || text.includes("backup snapshot"))
        return Float32Array.from([1, 0, 0, 0]);
      return Float32Array.from([0, 1, 0, 0]);
    },
  };
  const index = new EmbeddingIndex(f.path, embedder);
  try {
    decision(
      f.sources,
      f.knowledge,
      "ru",
      "Проверен отдельный бэкап телескопа.",
    );
    decision(
      f.sources,
      f.knowledge,
      "en",
      "The backup snapshot is stored for the fictional host.",
    );
    await index.reindexEmbeddings(4, () => {});
    const mcp = createContextMcp(f.sources, ["projects"], false, {
      knowledge: f.knowledge,
      embeddings: index,
    });
    const client = new Client({ name: "glossary-original", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (input, init) => mcp.fetch(new Request(input, init)),
      }),
    );
    try {
      const result = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          query: "бэкап",
          k: 5,
        },
      });
      const texts = (
        result.structuredContent as { items: { excerpt: { text: string } }[] }
      ).items.map((item) => item.excerpt.text);
      const russian = texts.findIndex((text) => text.includes("бэкап"));
      const english = texts.findIndex((text) =>
        text.includes("backup snapshot"),
      );
      assert.ok(russian >= 0, texts.join("\n"));
      assert.ok(english > russian, texts.join("\n"));
    } finally {
      await client.close();
      await mcp.close();
    }
  } finally {
    await index.close();
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("project glossary CLI sets, shows and unsets one term", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-glossary-cli-"));
  const path = join(directory, "context.db");
  const sources = new SourceStore(path);
  sources.createProject({
    id: "context",
    name: "Context",
    homeArea: "projects",
  });
  sources.close();
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTEXT_DB_PATH: path,
        CONTEXT_AREAS: "projects",
      },
    });
  try {
    const set = run([
      "project",
      "glossary",
      "set",
      "--id",
      "context",
      "--term",
      "дистилляция",
      "--synonyms",
      "distill,distillation,tidy",
    ]);
    assert.equal(set.status, 0, set.stderr);
    const shown = JSON.parse(
      run(["project", "glossary", "show", "--id", "context"]).stdout,
    ) as { terms: { term: string; synonyms: string[] }[] };
    assert.deepEqual(shown.terms, [
      {
        term: "дистилляция",
        synonyms: ["distill", "distillation", "tidy"],
      },
    ]);
    assert.equal(
      run([
        "project",
        "glossary",
        "unset",
        "--id",
        "context",
        "--term",
        "дистилляция",
      ]).status,
      0,
    );
    assert.deepEqual(
      JSON.parse(run(["project", "glossary", "show", "--id", "context"]).stdout)
        .terms,
      [],
    );
    assert.equal(
      run(["project", "glossary", "show", "--id", "missing"]).status,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
