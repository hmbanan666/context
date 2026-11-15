import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { AuthStore } from "../src/auth-store.js";

const url = "https://context.example/mcp";

function run(
  directory: string,
  args: string[],
  input?: string,
  areas = "personal",
) {
  return spawnSync(process.execPath, ["dist/scripts/context.js", ...args], {
    env: {
      ...process.env,
      CONTEXT_AUTH: "oauth",
      CONTEXT_PUBLIC_URL: url,
      CONTEXT_DB_PATH: join(directory, "context.db"),
      CONTEXT_AREAS: areas,
    },
    encoding: "utf8",
    ...(input ? { input } : {}),
  });
}

test("context init prints the MCP URL, one token, and client snippets once", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output-init-"));
  try {
    const first = run(directory, ["init"]);
    assert.equal(first.status, 0, first.stderr);
    const body = JSON.parse(first.stdout);
    assert.equal(body.mcpUrl, url);
    assert.equal(body.owner.created, true);
    assert.match(body.owner.password, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.admin.created, true);
    assert.equal(body.admin.client, "admin");
    assert.equal(body.admin.project, null);
    assert.match(body.admin.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.project, undefined);
    assert.deepEqual(body.mcp, {
      url,
      headers: { Authorization: `Bearer ${body.admin.token}` },
    });
    assert.deepEqual(body.cursor, {
      mcpServers: { context: body.mcp },
    });
    const store = new AuthStore(join(directory, "context.db"), ["personal"]);
    try {
      const access = store.access(body.admin.token, url);
      assert.deepEqual(access.grants.read, ["personal"]);
      assert.deepEqual(access.grants.write, ["personal"]);
      assert.equal(access.defaultWrite, "personal");
      assert.equal(access.grants.project, undefined);
    } finally {
      store.close();
    }
    const again = run(directory, ["init"]);
    assert.equal(again.status, 0, again.stderr);
    const repeat = JSON.parse(again.stdout);
    assert.equal(repeat.owner.created, false);
    assert.equal(repeat.owner.password, undefined);
    assert.equal(repeat.admin.created, false);
    assert.equal(repeat.admin.token, undefined);
    assert.equal(repeat.admin.project, null);
    assert.equal(repeat.mcp.headers.Authorization, "Bearer <already issued>");
    assert.equal(
      repeat.cursor.mcpServers.context.headers.Authorization,
      "Bearer <already issued>",
    );
    assert.equal(again.stdout.includes(body.admin.token), false);
    assert.equal(again.stdout.includes(body.owner.password), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context init creates one project and binds the admin token to it", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output-init-"));
  try {
    const first = run(directory, [
      "init",
      "--project",
      "lanterns",
      "--name",
      "Synthetic Lanterns",
    ]);
    assert.equal(first.status, 0, first.stderr);
    const body = JSON.parse(first.stdout);
    assert.deepEqual(body.project, {
      id: "lanterns",
      name: "Synthetic Lanterns",
      home: "personal",
      created: true,
    });
    assert.equal(body.admin.project, "lanterns");
    const store = new AuthStore(join(directory, "context.db"), ["personal"]);
    try {
      assert.equal(
        store.access(body.admin.token, url).grants.project,
        "lanterns",
      );
    } finally {
      store.close();
    }
    const again = run(directory, [
      "init",
      "--project",
      "lanterns",
      "--name",
      "Synthetic Lanterns",
    ]);
    assert.equal(again.status, 0, again.stderr);
    const repeat = JSON.parse(again.stdout);
    assert.equal(repeat.project.created, false);
    assert.equal(repeat.admin.created, false);
    assert.equal(again.stdout.includes(body.admin.token), false);
    assert.equal(again.stdout.includes(body.owner.password), false);
    const mismatch = run(directory, ["init"]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /not reprinted/);
    assert.equal(mismatch.stdout.includes(body.admin.token), false);
    assert.equal(mismatch.stdout.includes(body.owner.password), false);
    const renamed = run(directory, [
      "init",
      "--project",
      "lanterns",
      "--name",
      "Other",
    ]);
    assert.equal(renamed.status, 1);
    assert.match(renamed.stderr, /Project already exists/);
    assert.equal(renamed.stdout.includes(body.admin.token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context init leaves an existing owner in place and rejects a half-specified project", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output-init-"));
  try {
    const owner = run(
      directory,
      ["owner", "init"],
      "fictional CLI password 123\n",
    );
    assert.equal(owner.status, 0, owner.stderr);
    const first = run(directory, ["init"]);
    assert.equal(first.status, 0, first.stderr);
    const body = JSON.parse(first.stdout);
    assert.equal(body.owner.created, false);
    assert.equal(body.owner.password, undefined);
    assert.equal(body.admin.created, true);
    assert.equal(first.stdout.includes("fictional CLI password 123"), false);
    const missing = run(directory, ["init", "--project", "lanterns"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Project name is required/);
    assert.equal(missing.stdout.includes(body.admin.token), false);
    const nameOnly = run(directory, ["init", "--name", "Synthetic Lanterns"]);
    assert.equal(nameOnly.status, 1);
    assert.match(nameOnly.stderr, /Usage: context init/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
