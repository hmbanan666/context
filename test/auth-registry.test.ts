import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { AuthStore } from "../src/auth-store.js";

test("CLI credentials carry bounded grants and revoke immediately", () => {
  const store = new AuthStore(":memory:", ["personal", "garden"]);
  try {
    const issued = store.createCliToken(
      "fictional-worker",
      { read: ["personal", "garden"], write: ["garden"], process: [] },
      "garden",
      86400,
      "https://context.example/mcp",
    );
    const verified = store.access(issued.token, "https://context.example/mcp");
    assert.equal(verified.client.name, "fictional-worker");
    assert.equal(verified.defaultWrite, "garden");
    assert.deepEqual(verified.grants.write, ["garden"]);
    assert.throws(() =>
      store.access(issued.token, "https://other.example/mcp"),
    );
    assert.ok(!JSON.stringify(store.listTokens()).includes(issued.token));
    store.revokeToken(issued.id);
    assert.throws(() =>
      store.access(issued.token, "https://context.example/mcp"),
    );
  } finally {
    store.close();
  }
});

test("adding rights to a CLI client never broadens an older credential or mixes area/operation pairs", () => {
  const store = new AuthStore(":memory:", ["personal", "garden"]);
  const resource = "https://context.example/mcp";
  try {
    const narrow = store.createCliToken(
      "fictional-worker",
      { read: ["personal"], write: ["garden"], process: [] },
      "garden",
      86400,
      resource,
    );
    store.createCliToken(
      "fictional-worker",
      { read: ["garden"], write: ["personal"], process: ["garden"] },
      "personal",
      86400,
      resource,
    );
    assert.deepEqual(store.access(narrow.token, resource).grants, {
      read: ["personal"],
      write: ["garden"],
      process: [],
    });
    const client = store.listClients()[0];
    assert.deepEqual(client?.grants.read, ["personal", "garden"]);
    assert.equal(store.access(narrow.token, resource).defaultWrite, "garden");
  } finally {
    store.close();
  }
});

test("MCP bearer gate denies absent, foreign and revoked credentials and keeps the per-client request budget", async () => {
  const { protectMcp } = await import("../src/auth.js");
  const store = new AuthStore(":memory:", ["personal"]),
    resource = "https://context.example/mcp";
  const config = {
    resource,
    issuer: "https://context.example",
    areas: ["personal"],
    refreshSeconds: 86400,
    offlineSeconds: 2592000,
  };
  const handler = protectMcp(
    { fetch: async () => new Response(null, { status: 200 }) },
    config,
    store,
  );
  const call = (token?: string) =>
    handler.fetch(
      new Request(resource, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );
  try {
    const missing = await call();
    assert.equal(missing.status, 401);
    assert.match(
      missing.headers.get("www-authenticate") ?? "",
      /oauth-protected-resource/,
    );
    assert.equal((await call("foreign-token")).status, 401);
    const token = store.createCliToken(
      "fictional-worker",
      { read: ["personal"], write: [], process: [] },
      null,
      86400,
      resource,
    );
    for (let i = 0; i < 60; i++)
      assert.equal((await call(token.token)).status, 200);
    assert.equal((await call(token.token)).status, 429);
    store.revokeToken(token.id);
    assert.equal((await call(token.token)).status, 401);
  } finally {
    store.close();
  }
});
