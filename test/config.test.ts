import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";

const grants = {
  "fictional-cli": { read: ["garden"], write: [], process: [] },
};
const oauth = {
  NODE_ENV: "production",
  CONTEXT_AUTH: "oauth",
  CONTEXT_PUBLIC_URL: "https://context.kosarev.space/mcp",
  CONTEXT_OAUTH_ISSUER: "https://context.kosarev.space/auth/realms/context",
  CONTEXT_OWNER_SUBJECT: "fictional-owner",
  CONTEXT_AREAS: "personal,garden",
  CONTEXT_CLIENT_GRANTS: JSON.stringify(grants),
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

test("protected mode requires explicit owner, grants, current provider URLs and no local bypass", () => {
  assert.deepEqual(readConfig(oauth).oauth?.clientGrants, grants);
  for (const change of [
    { CONTEXT_OWNER_SUBJECT: "" },
    { CONTEXT_PUBLIC_URL: "http://context.kosarev.space/mcp" },
    { CONTEXT_OAUTH_ISSUER: "https://untrusted.example" },
    { CONTEXT_AUTH: "none" },
    { CONTEXT_CLIENT_GRANTS: undefined },
    { CONTEXT_AREAS: "personal" },
    { CONTEXT_LOCAL_MCP: "enabled" },
    { CONTEXT_LOCAL_SCOPES: "garden" },
    { CONTEXT_PERSONAL_MEMORY: "enabled" },
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

test("grants require valid explicit operations and configured areas, and are OAuth-only", () => {
  for (const CONTEXT_CLIENT_GRANTS of [
    "",
    "null",
    "[]",
    "{}",
    "{",
    "x".repeat(16385),
    JSON.stringify({ client: { read: [], write: [] } }),
    JSON.stringify({ client: { read: ["unknown"], write: [], process: [] } }),
  ]) {
    assert.throws(() => readConfig({ ...oauth, CONTEXT_CLIENT_GRANTS }));
  }
  for (const local of [{}, { CONTEXT_LOCAL_MCP: "enabled" }]) {
    assert.throws(() =>
      readConfig({ ...local, CONTEXT_CLIENT_GRANTS: JSON.stringify(grants) }),
    );
  }
});
