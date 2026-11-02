import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readConfig } from "../src/config.js";

const oauth = {
  NODE_ENV: "production",
  CONTEXT_AUTH: "oauth",
  CONTEXT_PUBLIC_URL: "https://context.example/mcp",
  CONTEXT_AREAS: "personal,garden",
};

test("defaults to a persistent local database and validates configuration", () => {
  assert.deepEqual(readConfig({}), {
    port: 3000,
    databasePath: "./data/context.db",
  });
  assert.equal(readConfig({ NODE_ENV: "test", CONTEXT_PORT: "0" }).port, 0);
  for (const NODE_ENV of ["production", "staging", "preview"])
    assert.throws(() => readConfig({ NODE_ENV }));
  for (const CONTEXT_PORT of ["", "-1", "65536", "3.5", "abc", " 3000"])
    assert.throws(() => readConfig({ CONTEXT_PORT }));
  for (const CONTEXT_DB_PATH of ["", " ", ":memory:"])
    assert.throws(() => readConfig({ CONTEXT_DB_PATH }));
});

test("protected mode requires a portable HTTPS resource and rejects invalid auth and local bypass", () => {
  assert.equal(readConfig(oauth).oauth?.issuer, "https://context.example");
  for (const change of [
    { CONTEXT_PUBLIC_URL: "http://context.kosarev.space/mcp" },
    { CONTEXT_AUTH: "none" },
    { CONTEXT_PUBLIC_URL: "https://context.example/mcp?token=bad" },
    { CONTEXT_LOCAL_MCP: "enabled" },
  ])
    assert.throws(() => readConfig({ ...oauth, ...change }));
});

test("area configuration rejects malformed, duplicate, reserved and excessive areas", () => {
  for (const CONTEXT_AREAS of [
    "",
    " ",
    "personal,personal",
    "garden space",
    "Garden",
    "context:read",
    "offline_access",
    "x".repeat(81),
    Array.from({ length: 9 }, (_, i) => `area-${i}`).join(","),
  ]) {
    assert.throws(() =>
      readConfig({ CONTEXT_LOCAL_MCP: "enabled", CONTEXT_AREAS }),
    );
    assert.throws(() => readConfig({ ...oauth, CONTEXT_AREAS }));
  }
  assert.throws(() => readConfig({ CONTEXT_LOCAL_MCP: "true" }));
  // Existing names remain usable explicitly; startup never rewrites stored areas.
  assert.deepEqual(
    readConfig({
      CONTEXT_LOCAL_MCP: "enabled",
      CONTEXT_AREAS: "private:personal,synthetic:legacy",
    }).localMcpScopes,
    ["private:personal", "synthetic:legacy"],
  );
});

test("public URL enables OAuth with fixed lifetimes and accepts the old explicit selector", () => {
  const { CONTEXT_AUTH: _unused, ...env } = oauth;
  const configured = readConfig(env);
  assert.deepEqual(configured, readConfig(oauth));
  assert.equal(configured.oauth?.refreshSeconds, 86400);
  assert.equal(configured.oauth?.offlineSeconds, 30 * 86400);
});
