import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";

test("defaults to a persistent local database and validates configuration", () => {
  assert.deepEqual(readConfig({}), {
    port: 3000,
    databasePath: "./data/context.db",
  });
  assert.equal(readConfig({ NODE_ENV: "test", CONTEXT_PORT: "0" }).port, 0);
  for (const NODE_ENV of ["production", "staging", "preview"]) {
    assert.throws(() => readConfig({ NODE_ENV }));
  }
  for (const CONTEXT_PORT of ["", "-1", "65536", "3.5", "abc", " 3000"]) {
    assert.throws(() => readConfig({ CONTEXT_PORT }));
  }
  for (const CONTEXT_DB_PATH of ["", " ", ":memory:"]) {
    assert.throws(() => readConfig({ CONTEXT_DB_PATH }));
  }
});
