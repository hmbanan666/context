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

test("protected mode requires the approved HTTPS URLs, explicit owner and no local bypass", () => {
  const env = {
    NODE_ENV: "production",
    CONTEXT_AUTH: "oauth",
    CONTEXT_PUBLIC_URL: "https://context.kosarev.space/mcp",
    CONTEXT_OAUTH_ISSUER: "https://context.kosarev.space/auth/realms/context",
    CONTEXT_OWNER_SUBJECT: "synthetic-owner",
  };
  assert.ok(readConfig(env).oauth);
  for (const change of [
    { CONTEXT_OWNER_SUBJECT: "" },
    { CONTEXT_PUBLIC_URL: "http://context.kosarev.space/mcp" },
    { CONTEXT_OAUTH_ISSUER: "https://untrusted.example" },
    { CONTEXT_AUTH: "none" },
    { CONTEXT_LOCAL_MCP: "synthetic" },
    { CONTEXT_LOCAL_SCOPES: "synthetic:hosted-pilot" },
  ])
    assert.throws(() => readConfig({ ...env, ...change }));
});

test("local MCP is opt-in and can only grant explicit synthetic scopes", () => {
  assert.equal(readConfig({}).localMcpScopes, undefined);
  assert.deepEqual(
    readConfig({ CONTEXT_LOCAL_MCP: "synthetic" }).localMcpScopes,
    ["synthetic:local-foundation"],
  );
  assert.deepEqual(
    readConfig({
      CONTEXT_LOCAL_MCP: "synthetic",
      CONTEXT_LOCAL_SCOPES: "synthetic:a,synthetic:b",
    }).localMcpScopes,
    ["synthetic:a", "synthetic:b"],
  );
  for (const env of [
    { CONTEXT_LOCAL_MCP: "true" },
    { CONTEXT_LOCAL_SCOPES: "synthetic:a" },
    { CONTEXT_LOCAL_MCP: "synthetic", CONTEXT_LOCAL_SCOPES: "private:notes" },
    { CONTEXT_LOCAL_MCP: "synthetic", CONTEXT_LOCAL_SCOPES: "" },
    {
      CONTEXT_LOCAL_MCP: "synthetic",
      CONTEXT_LOCAL_SCOPES: "synthetic:a,synthetic:a",
    },
    { NODE_ENV: "production", CONTEXT_LOCAL_MCP: "synthetic" },
  ])
    assert.throws(() => readConfig(env));
});

test("client grants are strict operator configuration confined to authenticated mode", () => {
  const env = {
    NODE_ENV: "production",
    CONTEXT_AUTH: "oauth",
    CONTEXT_PUBLIC_URL: "https://context.kosarev.space/mcp",
    CONTEXT_OAUTH_ISSUER: "https://context.kosarev.space/auth/realms/context",
    CONTEXT_OWNER_SUBJECT: "synthetic-owner",
  };
  const grants = {
    "context-codex": { read: ["synthetic:project:a"], write: [], process: [] },
  };
  assert.deepEqual(
    readConfig({ ...env, CONTEXT_CLIENT_GRANTS: JSON.stringify(grants) }).oauth
      ?.clientGrants,
    grants,
  );
  for (const CONTEXT_CLIENT_GRANTS of [
    "",
    " ",
    "null",
    "[]",
    "{}",
    "{",
    "x".repeat(16385),
    JSON.stringify({ "context-codex": { read: [], write: [] } }),
    JSON.stringify({ arbitrary: { read: [], write: [], process: [] } }),
    JSON.stringify({
      "context-codex": { read: ["private:notes"], write: [], process: [] },
    }),
  ]) {
    assert.throws(() => readConfig({ ...env, CONTEXT_CLIENT_GRANTS }));
  }
  for (const local of [
    {},
    { CONTEXT_LOCAL_MCP: "synthetic" },
    {
      CONTEXT_LOCAL_MCP: "synthetic",
      CONTEXT_LOCAL_SCOPES: "synthetic:project:a",
    },
  ]) {
    assert.throws(() =>
      readConfig({ ...local, CONTEXT_CLIENT_GRANTS: JSON.stringify(grants) }),
    );
  }
});
