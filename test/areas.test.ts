import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readConfig } from "../src/config.js";

test("local development defaults to personal and accepts only configured areas", () => {
  assert.deepEqual(
    readConfig({ CONTEXT_LOCAL_MCP: "enabled" }).localMcpScopes,
    ["personal"],
  );
  assert.deepEqual(
    readConfig({
      CONTEXT_LOCAL_MCP: "enabled",
      CONTEXT_AREAS: "personal,garden",
    }).localMcpScopes,
    ["personal", "garden"],
  );
  assert.throws(() =>
    readConfig({ NODE_ENV: "production", CONTEXT_LOCAL_MCP: "enabled" }),
  );
});
