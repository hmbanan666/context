import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  calibrateSeparation,
  formatExplain,
  formatSeparation,
  type ExplainRow,
} from "../src/grounding-cli.js";
import { defaultGroundingThresholds } from "../src/grounding.js";
import { SourceStore } from "../src/store.js";

test("separation reports on/off distributions and the cuts that split them", () => {
  const summary = calibrateSeparation([
    { cosine: 0.9, rareShare: 0.1, expect: "on" },
    { cosine: 0.91, rareShare: 0.2, expect: "on" },
    { cosine: 0.4, rareShare: 0.1, expect: "off" },
    { cosine: 0.5, rareShare: 0.2, expect: "off" },
  ]);
  assert.equal(summary.cosine.on.n, 2);
  assert.equal(summary.cosine.on.min, 0.9);
  assert.equal(summary.cosine.on.max, 0.91);
  assert.equal(summary.cosine.off.n, 2);
  assert.equal(summary.cosine.off.p50, 0.4);
  assert.equal(summary.rareShare.on.n, 2);
  assert.equal(summary.cosineCut?.cut, 0.9);
  assert.equal(summary.cosineCut?.onCorrect, 2);
  assert.equal(summary.cosineCut?.onTotal, 2);
  assert.equal(summary.cosineCut?.offCorrect, 2);
  assert.equal(summary.cosineCut?.offTotal, 2);
  assert.ok(
    (summary.rareShareCut?.onCorrect ?? 0) +
      (summary.rareShareCut?.offCorrect ?? 0) <
      4,
  );
  assert.equal(summary.combined?.onCorrect, 2);
  assert.equal(summary.combined?.offCorrect, 2);
  assert.ok(summary.combined?.op === "and" || summary.combined?.op === "or");
  const text = formatSeparation(summary);
  assert.match(text, /^summary:\n/);
  assert.match(text, /cosine cut >= 0\.9: on 2\/2 off 2\/2/);
  assert.match(text, /rareShare cut /);
  assert.match(text, /combined: rareShare .+ (and|or) cosine /);
  const oneSided = calibrateSeparation([
    { cosine: 1, rareShare: 1, expect: "on" },
  ]);
  assert.equal(oneSided.separation, "need both on and off");
  assert.equal(oneSided.cosineCut, undefined);
  assert.match(formatSeparation(oneSided), /separation: need both on and off/);
});

test("explain text lists the grounding features", () => {
  const row: ExplainRow = {
    query: "weather in Paris",
    area: "personal",
    grounding: "none",
    cosine: 0,
    rareShare: 0,
    matchedRare: [],
    commonDropped: ["weather", "paris"],
    corpus: 41,
    documentFrequency: [
      { term: "weather", df: 40, common: true },
      { term: "paris", df: 40, common: true },
    ],
    thresholds: defaultGroundingThresholds,
    vectors: false,
    topHit: { id: "src-1", title: "Weather bot" },
  };
  const text = formatExplain(row);
  assert.match(text, /grounding: none/);
  assert.match(text, /cosine: 0/);
  assert.match(text, /rareShare: 0/);
  assert.match(text, /matchedRare: -/);
  assert.match(text, /commonDropped: weather, paris/);
  assert.match(text, /corpus: 41/);
  assert.match(text, /documentFrequency: weather=40 common, paris=40 common/);
  assert.match(text, /cosineWeak=0\.84/);
  assert.match(text, /commonCorpus=40/);
  assert.match(text, /vectors: false/);
  assert.match(text, /topHit: src-1 Weather bot/);
});

test("grounding explain prints a query and a file summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-explain-"));
  const path = join(directory, "context.db");
  const store = new SourceStore(path);
  const saved = store.captureMaterial({
    version: 1,
    scope: "personal",
    origin: "synthetic",
    idempotencyKey: "lantern",
    text: "The cobalt lantern is in the blue cabinet.",
    metadata: { title: "Cobalt lantern" },
  });
  for (let index = 0; index < 40; index += 1) {
    store.capture({
      version: 1,
      scope: "personal",
      origin: "synthetic",
      idempotencyKey: `weather-${index}`,
      text: `Weather bot ${index} tagged Paris in the payload.`,
    });
  }
  store.close();
  const env = {
    ...process.env,
    CONTEXT_DB_PATH: path,
    CONTEXT_AREAS: "personal",
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
    });
  try {
    const hit = run([
      "grounding",
      "explain",
      "--query",
      "cobalt lantern",
      "--json",
    ]);
    assert.equal(hit.status, 0, hit.stderr);
    const body = JSON.parse(hit.stdout) as ExplainRow;
    assert.equal(body.grounding, "strong");
    assert.equal(body.area, "personal");
    assert.equal(body.cosine, 0);
    assert.ok(body.rareShare >= 0.75);
    assert.deepEqual(body.matchedRare, ["cobalt", "lantern"]);
    assert.deepEqual(body.commonDropped, []);
    assert.equal(body.corpus, 41);
    assert.equal(body.vectors, false);
    assert.deepEqual(
      body.documentFrequency.map((term) => term.term),
      ["cobalt", "lantern"],
    );
    assert.equal(body.thresholds.cosineWeak, 0.84);
    assert.equal(body.thresholds.cosineStrong, 0.92);
    assert.equal(body.topHit?.id, saved.material.source.id);
    assert.equal(body.topHit?.title, "Cobalt lantern");
    const human = run(["grounding", "explain", "--query", "cobalt lantern"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /grounding: strong/);
    assert.match(human.stdout, /matchedRare: cobalt, lantern/);
    assert.match(human.stdout, /topHit: .+ Cobalt lantern/);
    const file = join(directory, "questions.yaml");
    await writeFile(
      file,
      [
        "- query: cobalt lantern",
        "  expect: on",
        "- query: weather in Paris",
        "  expect: off",
        "",
      ].join("\n"),
    );
    const batch = run(["grounding", "explain", "--file", file, "--json"]);
    assert.equal(batch.status, 0, batch.stderr);
    const report = JSON.parse(batch.stdout) as {
      queries: ExplainRow[];
      summary: ReturnType<typeof calibrateSeparation>;
    };
    assert.equal(report.queries.length, 2);
    assert.equal(report.queries[0]?.grounding, "strong");
    assert.equal(report.queries[0]?.expect, "on");
    assert.equal(report.queries[1]?.grounding, "none");
    assert.equal(report.queries[1]?.expect, "off");
    assert.deepEqual(report.queries[1]?.commonDropped, ["weather", "paris"]);
    assert.deepEqual(report.queries[1]?.matchedRare, []);
    assert.equal(report.summary.cosine.on.n, 1);
    assert.equal(report.summary.cosine.off.n, 1);
    assert.equal(report.summary.rareShare.on.n, 1);
    assert.equal(report.summary.rareShare.off.n, 1);
    assert.equal(report.summary.rareShareCut?.onCorrect, 1);
    assert.equal(report.summary.rareShareCut?.offCorrect, 1);
    assert.equal(report.summary.combined?.onCorrect, 1);
    assert.equal(report.summary.combined?.offCorrect, 1);
    assert.equal(report.summary.cosineCut?.cut, null);
    const printed = run(["grounding", "explain", "--file", file]);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /grounding: none/);
    assert.match(printed.stdout, /summary:/);
    assert.match(printed.stdout, /rareShare cut /);
    assert.match(printed.stdout, /combined: /);
    assert.equal(
      run(["grounding", "explain", "--query", "x", "--file", file]).status,
      1,
    );
    const unknown = run([
      "grounding",
      "explain",
      "--query",
      "cobalt lantern",
      "--area",
      "garden",
    ]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown area/);
    assert.match(
      run(["grounding", "explain"]).stderr,
      /Usage: context grounding explain/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
