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
import {
  expandQueryTerms,
  builtinGlossary,
  glossaryWordsMatch,
} from "../src/glossary.js";
import { conceptCoverage } from "../src/search-lexical.js";
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
  assert.deepEqual(expanded, [
    { term: "nightly", from: [1] },
    { term: "distill", from: [2] },
    { term: "distillation", from: [2] },
  ]);
  assert.equal(
    expandQueryTerms(
      ["бэкап"],
      [...builtinGlossary, { term: "дистилляция", synonyms: ["tidy"] }],
    ).some((entry) => entry.term === "tidy"),
    false,
  );
  const overridden = expandQueryTerms(
    ["дистилляцию"],
    [
      ...builtinGlossary.filter((entry) => entry.term !== "дистилляция"),
      { term: "дистилляция", synonyms: ["tidy"] },
    ],
  );
  assert.deepEqual(overridden, [{ term: "tidy", from: [0] }]);
  assert.equal(glossaryWordsMatch("ночную", "ночная"), true);
  assert.equal(glossaryWordsMatch("уборку", "уборка"), true);
  assert.equal(glossaryWordsMatch("списка", "список"), true);
  assert.equal(glossaryWordsMatch("покупки", "покупок"), true);
  assert.equal(glossaryWordsMatch("истины", "истина"), true);
  assert.equal(glossaryWordsMatch("ночник", "ночная"), false);
  assert.equal(glossaryWordsMatch("графина", "график"), false);
  assert.deepEqual(
    expandQueryTerms(
      ["запустить", "ночную", "уборку"],
      [{ term: "ночная уборка", synonyms: ["nightly tidy"] }],
    ),
    [{ term: "nightly tidy", from: [1, 2] }],
  );
  assert.deepEqual(
    expandQueryTerms(
      ["проверить", "списка", "покупок"],
      [{ term: "список покупок", synonyms: ["shopping list"] }],
    ),
    [{ term: "shopping list", from: [1, 2] }],
  );
  const covered = conceptCoverage(
    "Nightly distillation stores the proposed fact.",
    ["улучшить", "ночную", "дистилляцию"],
    expanded,
  );
  const oneWord = conceptCoverage(
    "Ночную резервную копию хранит отдельный снимок.",
    ["улучшить", "ночную", "дистилляцию"],
    expanded,
  );
  assert.equal(covered.concepts, 2);
  assert.equal(covered.exact, false);
  assert.equal(oneWord.concepts, 1);
  assert.equal(oneWord.exact, true);
  assert.ok(covered.concepts > oneWord.concepts);
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
      assert.equal(backup, -1, texts.join("\n"));
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
    const mcp = createContextMcp(f.sources, ["projects"], false, {
      knowledge: f.knowledge,
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
    f.knowledge.close();
    f.sources.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("two query concepts outrank one exact original word", async () => {
  const f = await open("glossary-concepts");
  const embedder = {
    version: "synthetic-glossary-concepts",
    async embed(text: string, purpose: "query" | "passage") {
      if (purpose === "query" || text.includes("Ночную"))
        return Float32Array.from([1, 0, 0, 0]);
      return Float32Array.from([0, 1, 0, 0]);
    },
  };
  const index = new EmbeddingIndex(f.path, embedder);
  try {
    decision(
      f.sources,
      f.knowledge,
      "one-word",
      "Ночную резервную копию хранит отдельный снимок.",
    );
    decision(
      f.sources,
      f.knowledge,
      "two-concepts",
      "Nightly distillation stores the proposed fact.",
    );
    await index.reindexEmbeddings(4, () => {});
    const mcp = createContextMcp(f.sources, ["projects"], false, {
      knowledge: f.knowledge,
      embeddings: index,
    });
    const client = new Client({ name: "glossary-concepts", version: "1" });
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
      const searched = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          query: "улучшить ночную дистилляцию",
          k: 5,
        },
      });
      const texts = (
        searched.structuredContent as { items: { excerpt: { text: string } }[] }
      ).items.map((item) => item.excerpt.text);
      const focused = texts.findIndex((text) => text.includes("distillation"));
      const broad = texts.findIndex((text) => text.includes("Ночную"));
      assert.ok(focused >= 0, texts.join("\n"));
      assert.ok(broad > focused, texts.join("\n"));
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
      const packed = (
        pack.structuredContent as { items: { excerpt: { text: string } }[] }
      ).items.map((item) => item.excerpt.text);
      assert.ok(
        packed.some((text) => text.includes("distillation")),
        packed.join("\n"),
      );
      assert.equal(
        packed.some((text) => text.includes("Ночную")),
        false,
        packed.join("\n"),
      );
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

test("a multi-word glossary phrase matches an inflected Russian query", async () => {
  const f = await open("glossary-phrase");
  try {
    f.sources.setGlossaryTerm({
      projectId: "context",
      term: "ночная уборка",
      synonyms: ["nightly tidy"],
    });
    f.sources.setGlossaryTerm({
      projectId: "context",
      term: "список покупок",
      synonyms: ["shopping list"],
    });
    f.sources.setGlossaryTerm({
      projectId: "context",
      term: "источник истины",
      synonyms: ["source of truth"],
    });
    decision(
      f.sources,
      f.knowledge,
      "tidy",
      "The nightly tidy clears the fictional lane.",
    );
    decision(
      f.sources,
      f.knowledge,
      "list",
      "The shopping list is a fictional ledger.",
    );
    decision(
      f.sources,
      f.knowledge,
      "truth",
      "The source of truth is the fictional ledger.",
    );
    decision(
      f.sources,
      f.knowledge,
      "backup",
      "Nightly backups copy a SQLite snapshot.",
    );
    const mcp = createContextMcp(f.sources, ["projects"], false, {
      knowledge: f.knowledge,
    });
    const client = new Client({ name: "glossary-phrase", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: async (input, init) => mcp.fetch(new Request(input, init)),
      }),
    );
    try {
      const pack = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          mode: "pack",
          query: "запустить ночную уборку",
          budgetBytes: 4096,
        },
      });
      const texts = (
        pack.structuredContent as { items: { excerpt: { text: string } }[] }
      ).items.map((item) => item.excerpt.text);
      assert.ok(texts.some((text) => text.includes("nightly tidy")));
      assert.equal(
        texts.some((text) => text.includes("SQLite snapshot")),
        false,
      );
      const list = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          query: "проверить списка покупок",
          k: 5,
        },
      });
      assert.ok(
        JSON.stringify(list.structuredContent).includes("shopping list"),
      );
      const truth = await client.callTool({
        name: "search",
        arguments: {
          scope: "projects",
          project: "context",
          query: "где источник истины",
          k: 5,
        },
      });
      assert.ok(
        JSON.stringify(truth.structuredContent).includes("source of truth"),
      );
    } finally {
      await client.close();
      await mcp.close();
    }
  } finally {
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
    const phrase = run([
      "project",
      "glossary",
      "set",
      "--id",
      "context",
      "--term",
      "ночная уборка",
      "--synonyms",
      "nightly tidy",
    ]);
    assert.equal(phrase.status, 0, phrase.stderr);
    assert.deepEqual(
      JSON.parse(run(["project", "glossary", "show", "--id", "context"]).stdout)
        .terms,
      [{ term: "ночная уборка", synonyms: ["nightly tidy"] }],
    );
    assert.equal(
      run([
        "project",
        "glossary",
        "unset",
        "--id",
        "context",
        "--term",
        "ночная уборка",
      ]).status,
      0,
    );
    assert.equal(
      run([
        "project",
        "glossary",
        "set",
        "--id",
        "context",
        "--term",
        "one two three four five",
        "--synonyms",
        "too many",
      ]).status,
      1,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
