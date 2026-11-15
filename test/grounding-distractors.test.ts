import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { distractorNotes } from "../fixtures/curated/distractors.js";
import { stemText } from "../src/search-lexical.js";

const banned = [
  "mira",
  "quill",
  "amber",
  "lantern",
  "glyph",
  "glyphs",
  "orchard",
  "cedar",
  "kite",
  "wool",
  "tide",
  "brassharbor",
  "quay",
  "kazan",
  "mbappe",
  "mbappé",
  "luzhniki",
  "quantum",
  "chromodynamics",
  "gluon",
  "confinement",
  "won",
  "sourdough",
  "lovelace",
  "tolstoy",
  "quiet",
  "station",
  "painted",
  "designed",
  "hang",
  "glass",
  "routes",
  "festival",
  "archive",
  "index",
  "point",
  "people",
  "room",
  "waiting",
  "paper",
  "янтарный",
  "указатель",
  "фонарного",
  "фонарный",
  "приливные",
  "стеклянном",
  "кедровые",
  "бумажный",
  "квилл",
  "миры",
  "толстой",
];

test("distractors are a few hundred common-word notes without curated names", () => {
  const notes = distractorNotes();
  assert.ok(notes.length >= 300);
  const bannedStems = new Set(banned.map((word) => stemText(word)));
  const together = notes.some((item) => {
    const text = item.markdown.toLowerCase();
    const weather = text.indexOf("weather");
    const paris = text.indexOf("paris");
    return weather >= 0 && paris >= 0 && Math.abs(weather - paris) < 80;
  });
  const apart = notes.some((item) => {
    const text = item.markdown.toLowerCase();
    const weather = text.indexOf("weather");
    const paris = text.indexOf("paris");
    return weather >= 0 && paris >= 0 && Math.abs(weather - paris) > 500;
  });
  assert.equal(together, true);
  assert.equal(apart, true);
  for (const word of [
    "weather",
    "paris",
    "борщ",
    "рецепт",
    "penalty",
    "2018",
  ]) {
    const hits = notes.filter((item) =>
      item.markdown.toLowerCase().includes(word),
    ).length;
    assert.ok(hits >= 20, `${word} in ${hits} notes`);
  }
  for (const item of notes) {
    const tokens = item.markdown.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const token of tokens) {
      assert.equal(
        bannedStems.has(stemText(token)),
        false,
        `${token} in ${item.path}`,
      );
    }
  }
});
