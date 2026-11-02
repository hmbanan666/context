import assert from "node:assert/strict";
import { test } from "node:test";
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
