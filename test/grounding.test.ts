import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  buildContextPackage,
  searchGroundingReport,
} from "../src/context-package.js";
import {
  assessStoredGrounding,
  explainStoredGrounding,
  readGroundingThresholds,
  type GroundingPassage,
} from "../src/grounding.js";
import { KnowledgeStore } from "../src/knowledge.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

const thresholds = readGroundingThresholds({});
const frequent = new Map<string, number>([
  ["rare", 0],
  ["other", 0],
  ["common", 40],
  ["plain", 40],
]);

function ground(
  text: string,
  terms: readonly string[],
  options: {
    vectorsAvailable?: boolean;
    cosine?: number;
    documents?: number;
    documentFrequency?: ReadonlyMap<string, number>;
    unmatchedCosine?: number;
    background?: number;
    protectedTerms?: readonly string[];
  } = {},
) {
  const passages: GroundingPassage[] = text
    ? [
        {
          text,
          ...(options.cosine === undefined
            ? {}
            : { vectors: [{ offset: 0, score: options.cosine }] }),
        },
      ]
    : [];
  return assessStoredGrounding({
    terms,
    passages,
    documents: options.documents ?? 100,
    documentFrequency: options.documentFrequency ?? frequent,
    vectorsAvailable: options.vectorsAvailable ?? false,
    ...(options.unmatchedCosine === undefined
      ? {}
      : { unmatchedCosine: options.unmatchedCosine }),
    ...(options.background === undefined
      ? {}
      : { backgroundCosine: options.background }),
    ...(options.protectedTerms
      ? { protectedTerms: options.protectedTerms }
      : {}),
    thresholds,
  });
}

test("grounding uses passage co-occurrence and idf, not rank", () => {
  const rare = ["rare", "other"];
  const { marginWeak, marginStrong } = thresholds;
  assert.equal(ground("rare other", rare), "strong");
  assert.equal(
    ground("rare other", rare, {
      vectorsAvailable: true,
      cosine: 0,
      background: 0,
    }),
    "weak",
  );
  assert.equal(
    ground("rare other", rare, {
      vectorsAvailable: true,
      cosine: marginStrong,
      background: 0,
    }),
    "strong",
  );
  assert.equal(ground("rare", rare), "weak");
  assert.equal(ground(`rare ${"pad ".repeat(200)}other`, rare), "weak");
  assert.equal(
    ground("common plain", ["common", "plain"], {
      vectorsAvailable: true,
      cosine: marginWeak,
      background: 0,
    }),
    "weak",
  );
  assert.equal(
    ground("common plain", ["common", "plain"], {
      vectorsAvailable: true,
      cosine: marginStrong,
      background: 0,
    }),
    "weak",
  );
  assert.equal(
    ground("common plain", ["common", "plain"], {
      vectorsAvailable: true,
      cosine: 0,
      background: 0,
    }),
    "none",
  );
  assert.equal(ground("common plain", ["common", "plain"]), "none");
  assert.equal(
    ground("", ["rare"], {
      vectorsAvailable: true,
      unmatchedCosine: 0,
      background: 0,
    }),
    "none",
  );
  assert.equal(
    ground("", ["rare"], {
      vectorsAvailable: true,
      unmatchedCosine: marginWeak,
      background: 0,
    }),
    "weak",
  );
  assert.equal(
    ground("", ["rare"], {
      vectorsAvailable: true,
      unmatchedCosine: marginStrong,
      background: 0,
    }),
    "strong",
  );
  assert.equal(
    ground(
      "The cobalt lantern is in the blue cabinet.",
      ["cobalt", "lantern"],
      {
        documents: 1,
        documentFrequency: new Map([
          ["cobalt", 1],
          ["lantern", 1],
        ]),
      },
    ),
    "strong",
  );
  assert.equal(
    ground("На картинке только борщ.", ["борща"], {
      documents: 1,
      documentFrequency: new Map([["борща", 1]]),
    }),
    "strong",
  );
  assert.equal(readGroundingThresholds({}).lexicalOnlyStrong, 0.75);
  assert.equal(readGroundingThresholds({}).lexicalNone, 0.3);
  assert.equal(readGroundingThresholds({}).marginWeak, 0.024);
  assert.throws(() =>
    readGroundingThresholds({ CONTEXT_GROUNDING_MARGIN_WEAK: "1.2" }),
  );
  assert.throws(() =>
    readGroundingThresholds({ CONTEXT_GROUNDING_LEXICAL_NONE: "-0.1" }),
  );
  assert.throws(() =>
    readGroundingThresholds({
      CONTEXT_GROUNDING_MARGIN_WEAK: "0.5",
      CONTEXT_GROUNDING_MARGIN_STRONG: "0.2",
    }),
  );
  assert.throws(() =>
    readGroundingThresholds({
      CONTEXT_GROUNDING_LEXICAL_STRONG: "0.8",
      CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG: "0.7",
    }),
  );
  assert.throws(() =>
    readGroundingThresholds({ CONTEXT_GROUNDING_COMMON_RATE: "0" }),
  );
  assert.throws(() =>
    readGroundingThresholds({ CONTEXT_GROUNDING_COMMON_MIN_DF: "0" }),
  );
});

function remember(
  store: SourceStore,
  scope: string,
  key: string,
  text: string,
  projectId?: string,
) {
  const saved = store.capture({
    version: 1,
    scope,
    origin: "synthetic",
    idempotencyKey: key,
    text,
  });
  if (projectId)
    store.addClientAssociation("source", saved.source.id, [projectId]);
  return saved;
}

function groundingFor(
  store: SourceStore,
  knowledge: KnowledgeStore,
  scope: string,
  question: string,
  projectId?: string,
) {
  return buildContextPackage(
    store,
    knowledge,
    { version: 1, scope, question, limit: 8 },
    undefined,
    projectId,
  ).grounding;
}

test("a small rare share is none when the margin is below the weak floor", () => {
  const four = ["rare", "other", "third", "fourth"];
  const frequency = new Map(four.map((term) => [term, 0]));
  const partial = explainStoredGrounding({
    terms: four,
    passages: [{ text: "rare only" }],
    documents: 100,
    documentFrequency: frequency,
    vectorsAvailable: true,
    backgroundCosine: 0,
    thresholds,
  });
  assert.ok(partial.rareShare < thresholds.lexicalNone);
  assert.ok(partial.matchedRare.includes("rare"));
  assert.equal(partial.label, "none");
  assert.equal(partial.rule, "none-low-share-low-margin");
  assert.equal(partial.cosineSource, "missing");
  assert.equal(partial.margin, 0);
  const lifted = explainStoredGrounding({
    terms: four,
    passages: [
      {
        text: "rare only",
        vectors: [{ offset: 0, score: thresholds.marginWeak }],
      },
    ],
    documents: 100,
    documentFrequency: frequency,
    vectorsAvailable: true,
    backgroundCosine: 0,
    thresholds,
  });
  assert.equal(lifted.margin, thresholds.marginWeak);
  assert.equal(lifted.label, "weak");
  assert.equal(lifted.rule, "weak-rare");
  assert.equal(lifted.cosineSource, "vector");
  const shared = explainStoredGrounding({
    terms: ["rare", "other"],
    passages: [{ text: "rare only" }],
    documents: 100,
    documentFrequency: new Map([
      ["rare", 0],
      ["other", 0],
    ]),
    vectorsAvailable: true,
    backgroundCosine: 0.8,
    thresholds,
  });
  assert.ok(shared.rareShare >= thresholds.lexicalNone);
  assert.ok(shared.margin < thresholds.marginWeak);
  assert.equal(shared.label, "weak");
  assert.equal(shared.rule, "weak-rare");
  assert.equal(shared.cosineSource, "missing");
  const lexical = explainStoredGrounding({
    terms: four,
    passages: [{ text: "rare only" }],
    documents: 100,
    documentFrequency: frequency,
    vectorsAvailable: false,
    thresholds,
  });
  assert.equal(lexical.label, "none");
  assert.equal(lexical.rule, "none-lexical-share");
  assert.equal(lexical.cosineSource, "missing");
  const lexicalStrong = explainStoredGrounding({
    terms: ["rare", "other"],
    passages: [{ text: "rare other" }],
    documents: 100,
    documentFrequency: new Map([
      ["rare", 0],
      ["other", 0],
    ]),
    vectorsAvailable: false,
    thresholds,
  });
  assert.equal(lexicalStrong.label, "strong");
  assert.equal(lexicalStrong.rule, "strong-lexical");
  const noFloor = explainStoredGrounding({
    terms: four,
    passages: [{ text: "rare only" }],
    documents: 100,
    documentFrequency: frequency,
    vectorsAvailable: true,
    backgroundCosine: 0,
    thresholds: { ...thresholds, lexicalNone: 0 },
  });
  assert.equal(noFloor.label, "weak");
  assert.equal(noFloor.rule, "weak-rare");
});

test("common words in a large area are not strong evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-common-"));
  const store = new SourceStore(join(directory, "context.db"));
  const knowledge = new KnowledgeStore(join(directory, "context.db"));
  try {
    for (let index = 0; index < 40; index += 1) {
      remember(
        store,
        "personal",
        `weather-${index}`,
        `Weather bot ${index} tagged Paris in the payload. The weather icon for Paris is only an asset name.`,
      );
    }
    remember(
      store,
      "personal",
      "lantern",
      "The cobalt lantern is in the blue cabinet.",
    );
    assert.notEqual(
      groundingFor(store, knowledge, "personal", "weather in Paris"),
      "strong",
    );
    assert.equal(
      groundingFor(store, knowledge, "personal", "cobalt lantern"),
      "strong",
    );
  } finally {
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("document frequency stays inside the searched project and area", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-scope-"));
  const store = new SourceStore(join(directory, "context.db"));
  const knowledge = new KnowledgeStore(join(directory, "context.db"));
  try {
    store.createProject({
      id: "alpha",
      name: "Alpha",
      homeArea: "personal",
    });
    store.createProject({ id: "beta", name: "Beta", homeArea: "personal" });
    remember(
      store,
      "personal",
      "alpha-note",
      "Weather and Paris appear together in this short note.",
      "alpha",
    );
    for (let index = 0; index < 45; index += 1) {
      remember(
        store,
        "personal",
        `beta-${index}`,
        `Weather bot ${index} tagged Paris again.`,
        "beta",
      );
      remember(
        store,
        "garden",
        `garden-${index}`,
        `Weather bot ${index} tagged Paris in another area.`,
      );
    }
    remember(
      store,
      "studio",
      "studio-note",
      "Weather and Paris appear together in this short studio note.",
    );
    assert.equal(
      groundingFor(store, knowledge, "personal", "weather in Paris", "alpha"),
      "strong",
    );
    assert.equal(
      groundingFor(store, knowledge, "personal", "weather in Paris"),
      "none",
    );
    assert.equal(
      groundingFor(store, knowledge, "studio", "weather in Paris"),
      "strong",
    );
  } finally {
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("project identity stays rare and document frequency follows the match pool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-pool-"));
  const store = new SourceStore(join(directory, "context.db"));
  const knowledge = new KnowledgeStore(join(directory, "context.db"));
  try {
    store.createProject({
      id: "k39",
      name: "K39 Desk",
      homeArea: "personal",
    });
    store.setGlossaryTerm({
      projectId: "k39",
      term: "lantern",
      synonyms: ["lamp"],
    });
    let host = "";
    for (let index = 0; index < 40; index += 1) {
      const saved = remember(
        store,
        "personal",
        `desk-${index}`,
        `k39 lantern lamp note ${index} about the desk.`,
        "k39",
      );
      if (index === 0) host = saved.source.id;
    }
    knowledge.addDistilled({
      scope: "personal",
      sourceId: host,
      kind: "fact",
      text: "The таймфрейм on this desk is a fictional interval.",
      createdAt: "2026-01-15T00:00:00.000Z",
    });
    const project = searchGroundingReport(
      buildContextPackage(
        store,
        knowledge,
        { version: 1, scope: "personal", question: "таймфрейм", limit: 8 },
        undefined,
        "k39",
      ),
    );
    const timeframe = project?.documentFrequency.find(
      (term) => term.term === "таймфрейм",
    );
    assert.ok(timeframe);
    assert.equal(timeframe.df, 1);
    assert.equal(timeframe.common, false);
    assert.equal(project?.documents, 41);
    const area = searchGroundingReport(
      buildContextPackage(store, knowledge, {
        version: 1,
        scope: "personal",
        question: "таймфрейм",
        limit: 8,
      }),
    );
    assert.equal(
      area?.documentFrequency.find((term) => term.term === "таймфрейм")?.df,
      0,
    );
    const named = searchGroundingReport(
      buildContextPackage(
        store,
        knowledge,
        {
          version: 1,
          scope: "personal",
          question: "k39 lantern lamp",
          limit: 8,
        },
        undefined,
        "k39",
      ),
    );
    const byTerm = new Map(
      named?.documentFrequency.map((term) => [term.term, term]),
    );
    assert.equal(byTerm.get("k39")?.common, false);
    assert.equal(byTerm.get("lantern")?.common, false);
    assert.equal(byTerm.get("lamp")?.common, true);
    assert.ok((named?.rareShare ?? 0) > 0);
    assert.deepEqual(named?.commonDropped, ["lamp"]);
    const protectedOnly = explainStoredGrounding({
      terms: ["k39"],
      passages: [{ text: "k39 appears on every page." }],
      documents: 100,
      documentFrequency: new Map([["k39", 80]]),
      vectorsAvailable: false,
      protectedTerms: ["k39"],
      thresholds,
    });
    assert.equal(protectedOnly.documentFrequency[0]?.common, false);
    assert.equal(protectedOnly.rareShare, 1);
    assert.equal(protectedOnly.margin, 0);
  } finally {
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("margin is the best evidence cosine above the project centroid", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-margin-"));
  const path = join(directory, "context.db");
  const store = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const embedder = {
    version: "synthetic-margin-v1",
    async embed(text: string) {
      return Float32Array.from(/cobalt lantern/u.test(text) ? [1, 0] : [0, 1]);
    },
  };
  const index = new EmbeddingIndex(path, embedder);
  try {
    store.createProject({ id: "alpha", name: "Alpha", homeArea: "personal" });
    store.createProject({ id: "beta", name: "Beta", homeArea: "personal" });
    remember(
      store,
      "personal",
      "lantern",
      "The cobalt lantern is in the blue cabinet.",
      "alpha",
    );
    for (let index = 0; index < 6; index += 1)
      remember(
        store,
        "personal",
        `filler-${index}`,
        `Alpha filler note ${index} about ordinary weather.`,
        "alpha",
      );
    for (let index = 0; index < 20; index += 1)
      remember(
        store,
        "personal",
        `beta-${index}`,
        `Beta cobalt lantern leak ${index} should stay out of alpha.`,
        "beta",
      );
    index.backfill();
    while (await index.processOne()) {
      /* drain the synthetic queue */
    }
    const on = await index.search({
      scope: "personal",
      question: "where is the cobalt lantern",
      projectId: "alpha",
    });
    const off = await index.search({
      scope: "personal",
      question: "recipe for borscht",
      projectId: "alpha",
    });
    assert.equal(on.available, true);
    assert.ok((on.background ?? 0) < 0.4);
    assert.ok((on.sources[0]?.score ?? 0) > 0.9);
    const onPack = buildContextPackage(
      store,
      knowledge,
      {
        version: 1,
        scope: "personal",
        question: "where is the cobalt lantern",
        limit: 8,
      },
      on,
      "alpha",
    );
    const onReport = searchGroundingReport(onPack);
    assert.equal(onPack.grounding, "strong");
    assert.ok((onReport?.margin ?? 0) > 0.5);
    const offPack = buildContextPackage(
      store,
      knowledge,
      {
        version: 1,
        scope: "personal",
        question: "recipe for borscht",
        limit: 8,
      },
      off,
      "alpha",
    );
    const offReport = searchGroundingReport(offPack);
    assert.equal(offPack.grounding, "none");
    assert.ok((offReport?.margin ?? 1) < thresholds.marginWeak);
    const again = await index.search({
      scope: "personal",
      question: "where is the cobalt lantern",
      projectId: "alpha",
    });
    assert.equal(again.background, on.background);
  } finally {
    await index.close();
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rare passage below the retrieval floor uses its stored cosine", async () => {
  const { EmbeddingIndex } = await import("../src/embedding-index.js");
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-floor-"));
  const path = join(directory, "context.db");
  const store = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const embedder = {
    version: "synthetic-floor-v1",
    async embed(text: string, purpose: "query" | "passage" = "passage") {
      if (purpose === "query") return Float32Array.from([1, 0]);
      if (/cobalt lantern/u.test(text)) {
        const along = 0.7;
        return Float32Array.from([along, Math.sqrt(1 - along * along)]);
      }
      return Float32Array.from([0, 1]);
    },
  };
  const index = new EmbeddingIndex(path, embedder);
  try {
    remember(
      store,
      "personal",
      "lantern",
      "The cobalt lantern is in the blue cabinet.",
    );
    for (let index = 0; index < 6; index += 1)
      remember(
        store,
        "personal",
        `filler-${index}`,
        `Filler note ${index} about ordinary weather.`,
      );
    index.backfill();
    while (await index.processOne()) {
      /* drain the synthetic queue */
    }
    const found = await index.search({
      scope: "personal",
      question: "where is the cobalt lantern",
    });
    assert.equal(found.available, true);
    assert.equal(found.sources.length, 0);
    const pack = buildContextPackage(
      store,
      knowledge,
      {
        version: 1,
        scope: "personal",
        question: "where is the cobalt lantern",
        limit: 8,
      },
      found,
    );
    const report = searchGroundingReport(pack);
    assert.equal(report?.cosineSource, "vector");
    assert.ok((report?.cosine ?? 0) > 0.65);
    assert.ok((report?.cosine ?? 1) < 0.8);
    assert.ok((report?.margin ?? 0) > thresholds.marginStrong);
    assert.equal(report?.label, "strong");
    assert.equal(report?.rule, "strong-rare-margin");
    assert.deepEqual(report?.matchedRare, ["cobalt", "lantern"]);
  } finally {
    await index.close();
    knowledge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search tells the agent when nothing relevant was stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-grounding-"));
  const databasePath = join(directory, "context.db");
  const sources = new SourceStore(databasePath);
  const knowledge = new KnowledgeStore(databasePath);
  const mcp = createContextMcp(sources, ["personal"], false, { knowledge });
  const client = new Client({ name: "grounding-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (input, init) => mcp.fetch(new Request(input, init)),
    }),
  );
  try {
    const listed = await client.listTools();
    const search = listed.tools.find((tool) => tool.name === "search");
    assert.match(search?.description ?? "", /grounding/);
    assert.match(search?.description ?? "", /don't know/);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "read",
      "remember",
      "search",
      "timeline",
    ]);
    const saved = await client.callTool({
      name: "remember",
      arguments: {
        text: "The cobalt lantern is in the blue cabinet.",
        idempotencyKey: "lantern",
        scope: "personal",
      },
    });
    assert.equal(saved.isError, false);
    const hit = await client.callTool({
      name: "search",
      arguments: { scope: "personal", query: "cobalt lantern" },
    });
    assert.equal(hit.isError, false);
    assert.equal(
      (hit.structuredContent as { grounding?: string }).grounding,
      "strong",
    );
    const miss = await client.callTool({
      name: "search",
      arguments: { scope: "personal", query: "weather in Kazan tomorrow" },
    });
    assert.equal(miss.isError, false);
    assert.equal(
      (miss.structuredContent as { grounding?: string }).grounding,
      "none",
    );
  } finally {
    await client.close();
    await mcp.close();
    knowledge.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
