import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { AuthStore } from "../src/auth-store.js";

test("CLI initializes exactly one owner, prints credentials once, lists grants and revokes across reopen", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output-cli-"));
  const path = join(directory, "context.db");
  const env = {
    ...process.env,
    CONTEXT_AUTH: "oauth",
    CONTEXT_PUBLIC_URL: "https://context.example/mcp",
    CONTEXT_DB_PATH: path,
    CONTEXT_AREAS: "personal,garden",
  };
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
      env,
      encoding: "utf8",
      ...(input ? { input } : {}),
    });
  try {
    const initialized = run(["owner", "init"], "fictional CLI password 123\n");
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(
      run(["owner", "init"], "fictional second password\n").status,
      1,
    );
    const result = run([
      "token",
      "create",
      "fictional-worker",
      "--read",
      "personal,garden",
      "--write",
      "garden",
      "--default-write",
      "garden",
      "--expires",
      "90d",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const token = result.stdout.trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const list = run(["token", "list"]);
    assert.ok(!list.stdout.includes(token));
    const records = JSON.parse(list.stdout);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, "fictional-worker");
    assert.equal(records[0].used, false);
    assert.equal(records[0].lastUsed, null);
    const clients = JSON.parse(run(["client", "list"]).stdout);
    const worker = clients.find(
      (client: { name?: string }) => client.name === "fictional-worker",
    );
    assert.deepEqual(worker.grants.write, ["garden"]);
    const store = new AuthStore(path, ["personal", "garden"]);
    try {
      assert.equal(
        store.access(token, env.CONTEXT_PUBLIC_URL).defaultWrite,
        "garden",
      );
      assert.equal(
        store.access(token, env.CONTEXT_PUBLIC_URL).grants.project,
        undefined,
      );
      const project = run([
        "project",
        "create",
        "--id",
        "alpha",
        "--name",
        "Synthetic Alpha",
        "--home",
        "garden",
      ]);
      assert.equal(project.status, 0, project.stderr);
      const scoped = run([
        "token",
        "create",
        "fictional-alpha",
        "--read",
        "garden",
        "--write",
        "garden",
        "--default-write",
        "garden",
        "--project",
        "alpha",
      ]);
      assert.equal(scoped.status, 0, scoped.stderr);
      assert.equal(
        store.access(scoped.stdout.trim(), env.CONTEXT_PUBLIC_URL).grants
          .project,
        "alpha",
      );
      const missing = run([
        "token",
        "create",
        "fictional-missing",
        "--read",
        "garden",
        "--project",
        "missing",
      ]);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Unknown project/);
      assert.equal(run(["client", "revoke", worker.id]).status, 0);
      assert.throws(() => store.access(token, env.CONTEXT_PUBLIC_URL));
    } finally {
      store.close();
    }
    assert.equal(run(["token", "revoke", records[0].id]).status, 0);
    const after = JSON.parse(run(["token", "list"]).stdout);
    assert.equal(
      after.find((row: { id: string }) => row.id === records[0].id).revoked,
      true,
    );
    assert.equal(
      run([
        "token",
        "create",
        "bad",
        "--write",
        "unknown",
        "--default-write",
        "unknown",
      ]).status,
      1,
    );
    assert.equal(
      run(["token", "create", "bad", "--expires", "9999d"]).status,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
