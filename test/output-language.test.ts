import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { distillInstruction } from "../src/distill.js";
import {
  detectOutputLanguage,
  distillLanguageOverride,
  majorityLanguage,
  outputLanguageMatches,
  sourceLanguage,
} from "../src/output-language.js";

const german =
  "Das Projekt speichert die Quelle und der Satz bleibt auf Deutsch.";
const english =
  "The observatory kept the lantern and stored the source in English.";
const russian =
  "Обсерватория хранит фонарь и записывает источник на русском языке.";
const french =
  "Le projet garde la source dans le journal et les notes sont pour le client.";
const spanish =
  "El proyecto guarda la fuente para el equipo y los registros quedan listos.";

test("script and stopwords separate Russian, English, German, French and Spanish", () => {
  assert.equal(detectOutputLanguage(russian), "ru");
  assert.equal(detectOutputLanguage(english), "en");
  assert.equal(detectOutputLanguage(german), "de");
  assert.equal(detectOutputLanguage(french), "fr");
  assert.equal(detectOutputLanguage(spanish), "es");
  assert.equal(
    detectOutputLanguage(
      "В chatgame появилась страница персонажа, чтобы игрок видел прогресс.",
    ),
    "ru",
  );
  assert.equal(outputLanguageMatches(german, "en"), false);
  assert.equal(outputLanguageMatches(german, "ru"), false);
  assert.equal(outputLanguageMatches(german, "de"), true);
  assert.equal(outputLanguageMatches(english, "en"), true);
  assert.equal(outputLanguageMatches(russian, "ru"), true);
  assert.equal(
    sourceLanguage(
      "В chatgame появилась страница персонажа, чтобы игрок видел прогресс.",
    ),
    "ru",
  );
  assert.equal(sourceLanguage(english), "en");
});

test("journal language is the majority by item, and a tie is Russian", () => {
  assert.equal(majorityLanguage([english, english, russian]), "en");
  assert.equal(majorityLanguage([english, russian]), "ru");
  assert.equal(majorityLanguage([german, french]), "ru");
  assert.equal(majorityLanguage([russian, russian, english]), "ru");
  assert.equal(
    majorityLanguage([english, english], { CONTEXT_DISTILL_LANGUAGE: "ru" }),
    "ru",
  );
});

test("CONTEXT_DISTILL_LANGUAGE accepts ru and en and ignores anything else", () => {
  assert.equal(
    distillLanguageOverride({ CONTEXT_DISTILL_LANGUAGE: " RU " }),
    "ru",
  );
  assert.equal(
    distillLanguageOverride({ CONTEXT_DISTILL_LANGUAGE: "en" }),
    "en",
  );
  assert.equal(
    distillLanguageOverride({ CONTEXT_DISTILL_LANGUAGE: "german" }),
    undefined,
  );
  assert.equal(distillLanguageOverride({}), undefined);
  assert.match(
    distillInstruction({ CONTEXT_DISTILL_LANGUAGE: "en" }),
    /English \(en\)/,
  );
  assert.match(distillInstruction({}), /language of the source/);
  assert.equal(
    sourceLanguage(english, { CONTEXT_DISTILL_LANGUAGE: "ru" }),
    "ru",
  );
});
