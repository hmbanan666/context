import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeScope, configuredDataScopes } from "../src/access.js";
import { readConfig } from "../src/config.js";

test("owner-configured areas require both token scopes and explicit client grants", () => {
  const grants = {
    "fictional-cli": { read: ["garden"], write: [], process: [] },
  };
  assert.deepEqual(configuredDataScopes(grants), ["garden"]);
  assert.equal(
    authorizeScope(
      "fictional-cli",
      ["context:read", "garden"],
      "garden",
      "context:read",
      grants,
    ),
    true,
  );
  assert.equal(
    authorizeScope(
      "fictional-cli",
      ["context:read"],
      "garden",
      "context:read",
      grants,
    ),
    false,
  );
  assert.equal(
    authorizeScope(
      "fictional-cli",
      ["context:write", "garden"],
      "garden",
      "context:write",
      grants,
    ),
    false,
  );
  assert.equal(
    authorizeScope(
      "fictional-cli",
      ["context:read", "garden"],
      "garden",
      "context:read",
    ),
    false,
  );
});

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
