import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeScope,
  type ClientGrants,
  clientGrantsSchema,
  configuredDataScopes,
  operationScopes,
} from "../src/access.js";

const projectA = "synthetic:project:a";
const projectB = "synthetic:project:b";
const grants: ClientGrants = {
  "context-chatgpt": {
    read: [projectA, projectB],
    write: [projectA, projectB],
    process: [projectB],
  },
  "context-codex": { read: [projectA], write: [], process: [] },
};
const fullToken = [...operationScopes, projectA, projectB];

test("operator grants require signed operation and data scopes independently for every client", () => {
  assert.equal(
    authorizeScope(
      "context-chatgpt",
      fullToken,
      projectB,
      "context:write",
      grants,
    ),
    true,
  );
  assert.equal(
    authorizeScope(
      "context-codex",
      fullToken,
      projectA,
      "context:read",
      grants,
    ),
    true,
  );
  for (const [clientId, scope, operation] of [
    ["context-codex", projectB, "context:read"],
    ["context-codex", projectA, "context:write"],
    ["context-codex", projectA, "context:process"],
    ["context-chatgpt", projectA, "context:process"],
    ["unknown-client", projectA, "context:read"],
  ] as const) {
    assert.equal(
      authorizeScope(clientId, fullToken, scope, operation, grants),
      false,
    );
  }
  assert.equal(
    authorizeScope(
      "context-chatgpt",
      fullToken,
      projectB,
      "context:process",
      grants,
    ),
    true,
  );
  for (const tokenScopes of [
    ["context:read"],
    [projectA],
    ["context:write", projectA],
    [],
  ]) {
    assert.equal(
      authorizeScope(
        "context-codex",
        tokenScopes,
        projectA,
        "context:read",
        grants,
      ),
      false,
    );
  }
});

test("an explicit grant map never inherits defaults for missing clients or missing grants", () => {
  const explicit: ClientGrants = {
    "context-chatgpt": { read: [], write: [], process: [] },
  };
  const pilotToken = [...operationScopes, "synthetic:hosted-pilot"];
  for (const clientId of ["context-chatgpt", "context-codex"]) {
    for (const operation of operationScopes) {
      assert.equal(
        authorizeScope(
          clientId,
          pilotToken,
          "synthetic:hosted-pilot",
          operation,
          explicit,
        ),
        false,
      );
    }
  }
  assert.deepEqual(configuredDataScopes(explicit), []);
  assert.deepEqual(configuredDataScopes(grants), [projectA, projectB]);
});

test("unconfigured policy preserves pilot read/write and never grants processing", () => {
  const tokenScopes = [...operationScopes, "synthetic:hosted-pilot", projectA];
  for (const clientId of ["context-chatgpt", "context-codex"]) {
    assert.equal(
      authorizeScope(
        clientId,
        tokenScopes,
        "synthetic:hosted-pilot",
        "context:read",
      ),
      true,
    );
    assert.equal(
      authorizeScope(
        clientId,
        tokenScopes,
        "synthetic:hosted-pilot",
        "context:write",
      ),
      true,
    );
    assert.equal(
      authorizeScope(
        clientId,
        tokenScopes,
        "synthetic:hosted-pilot",
        "context:process",
      ),
      false,
    );
    assert.equal(
      authorizeScope(clientId, tokenScopes, projectA, "context:read"),
      false,
    );
  }
  assert.deepEqual(configuredDataScopes(), ["synthetic:hosted-pilot"]);
});

test("grant configuration rejects unknown keys, missing operations, duplicate and oversized scopes", () => {
  for (const input of [
    {},
    { ...grants, arbitrary: grants["context-codex"] },
    { "context-codex": { read: [projectA], write: [] } },
    {
      "context-codex": {
        read: [projectA],
        write: [],
        process: [],
        approve: [projectA],
      },
    },
    {
      "context-codex": { read: ["private:manuscript"], write: [], process: [] },
    },
    { "context-codex": { read: [projectA, projectA], write: [], process: [] } },
    {
      "context-codex": {
        read: Array.from({ length: 9 }, (_, i) => `synthetic:p${i}`),
        write: [],
        process: [],
      },
    },
    {
      "context-codex": {
        read: [`synthetic:${"x".repeat(80)}`],
        write: [],
        process: [],
      },
    },
  ]) {
    assert.equal(clientGrantsSchema.safeParse(input).success, false);
  }
});
