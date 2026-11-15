import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { buildContextPackage } from "../src/context-package.js";
import {
  assessStoredGrounding,
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
    thresholds,
  });
}

test("grounding uses passage co-occurrence and idf, not rank", () => {
  const rare = ["rare", "other"];
  assert.equal(ground("rare other", rare), "strong");
  assert.equal(
    ground("rare other", rare, { vectorsAvailable: true, cosine: 0.5 }),
    "weak",
  );
  assert.equal(
    ground("rare other", rare, { vectorsAvailable: true, cosine: 0.93 }),
    "strong",
  );
  assert.equal(ground("rare", rare), "weak");
  assert.equal(ground(`rare ${"pad ".repeat(200)}other`, rare), "weak");
  assert.equal(
    ground("common plain", ["common", "plain"], {
      vectorsAvailable: true,
      cosine: 0.99,
    }),
    "weak",
  );
  assert.equal(
    ground("common plain", ["common", "plain"], {
      vectorsAvailable: true,
      cosine: 0.87,
    }),
    "weak",
  );
  assert.equal(
    ground("common plain", ["common", "plain"], {
      vectorsAvailable: true,
      cosine: 0.5,
    }),
    "none",
  );
  assert.equal(ground("common plain", ["common", "plain"]), "none");
  assert.equal(ground("", ["rare"], { unmatchedCosine: 0.8 }), "none");
  assert.equal(ground("", ["rare"], { unmatchedCosine: 0.87 }), "weak");
  assert.equal(ground("", ["rare"], { unmatchedCosine: 0.93 }), "strong");
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
  assert.throws(() =>
    readGroundingThresholds({ CONTEXT_GROUNDING_COSINE_WEAK: "1.2" }),
  );
  assert.throws(() =>
    readGroundingThresholds({
      CONTEXT_GROUNDING_COSINE_WEAK: "0.95",
      CONTEXT_GROUNDING_COSINE_STRONG: "0.9",
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
