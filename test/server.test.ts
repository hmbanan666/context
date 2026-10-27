import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startService } from "../src/server.js";

test("only health is exposed on loopback; private routes do not exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-http-"));
  const service = await startService({
    port: 0,
    databasePath: join(directory, "context.db"),
  });
  try {
    assert.equal(service.address.address, "127.0.0.1");
    const url = `http://127.0.0.1:${service.address.port}`;
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok" });
    const write = await fetch(`${url}/health`, { method: "POST" });
    assert.equal(write.status, 405);
    for (const path of ["/mcp", "/capture", "/recall", "/sources"]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${url}${path}`, { method });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: "not_found" });
      }
    }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
