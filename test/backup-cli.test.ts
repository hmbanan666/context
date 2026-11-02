import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SourceStore } from "../src/store.js";

const exec = promisify(execFile);
const backupCli = fileURLToPath(
  new URL("../scripts/backup.js", import.meta.url),
);
const databaseCli = fileURLToPath(
  new URL("../scripts/database.js", import.meta.url),
);
const main = fileURLToPath(new URL("../src/main.js", import.meta.url));

async function fixture() {
  await mkdir(join(process.cwd(), ".output"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-cli-"));
  const databasePath = join(directory, "source.db");
  const backups = join(directory, "backups");
  const store = new SourceStore(databasePath);
  const saved = store.capture({
    version: 1,
    text: "Fictional cedar bird",
    origin: "fixture:cli",
    scope: "synthetic:backup",
    idempotencyKey: "cli-1",
  });
  store.close();
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    CONTEXT_PORT: "0",
    CONTEXT_DB_PATH: databasePath,
    CONTEXT_BACKUP_DIR: backups,
    CONTEXT_BACKUP_AT: "00:00",
    CONTEXT_BACKUP_TIMEZONE: "UTC",
  };
  return { directory, databasePath, backups, env, saved };
}

test("owner CLI backs up now, reads private status, and restores only into an absent file", async () => {
  const f = await fixture();
  try {
    const { stdout } = await exec(process.execPath, [backupCli], {
      env: f.env,
    });
    const status = JSON.parse(stdout);
    assert.equal(status.outcome, "success");
    assert.equal(
      JSON.parse(
        (await exec(process.execPath, [backupCli, "status"], { env: f.env }))
          .stdout,
      ).file,
      status.file,
    );
    const restored = join(f.directory, "restored.db");
    await exec(
      process.execPath,
      [databaseCli, "restore", join(f.backups, status.file), restored],
      { env: f.env },
    );
    const clone = new SourceStore(restored);
    try {
      assert.deepEqual(
        clone.find(f.saved.source.id, f.saved.source.scope),
        f.saved.source,
      );
    } finally {
      clone.close();
    }
    await assert.rejects(
      exec(
        process.execPath,
        [databaseCli, "restore", join(f.backups, status.file), f.databasePath],
        { env: f.env },
      ),
    );
    await assert.rejects(
      exec(process.execPath, [backupCli, "invalid"], { env: f.env }),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("actual process schedules once across restarts and exposes no public backup status", {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  try {
    for (let restart = 0; restart < 2; restart++) {
      const child = spawn(process.execPath, [main], {
        env: f.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      const exit = once(child, "exit");
      try {
        let port: number | undefined;
        for (let i = 0; i < 200; i++) {
          const event = output
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .find((event) => event.event === "listening");
          if (event) {
            port = event.port;
            break;
          }
          await delay(20);
        }
        assert.ok(port);
        for (let i = 0; i < 200; i++) {
          const status = await readFile(
            join(f.backups, "status.json"),
            "utf8",
          ).catch(() => "{}");
          if (JSON.parse(status).outcome === "success") break;
          await delay(20);
        }
        assert.equal(
          JSON.parse(await readFile(join(f.backups, "status.json"), "utf8"))
            .outcome,
          "success",
        );
        assert.deepEqual(
          await (await fetch(`http://127.0.0.1:${port}/health`)).json(),
          { status: "ok" },
        );
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/backups`)).status,
          404,
        );
        assert.equal(
          (await readdir(f.backups)).filter((name) =>
            /^context-.*\.db$/.test(name),
          ).length,
          1,
        );
      } finally {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
        const [code] = await exit;
        clearTimeout(kill);
        assert.equal(code, 0);
      }
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("readiness means graceful shutdown is already installed", {
  timeout: 15000,
}, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 8; i++) {
      const child = spawn(process.execPath, [main], {
        env: { ...f.env, CONTEXT_BACKUP_AT: "off" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      child.stdout.once("data", () => child.kill("SIGTERM"));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code, signal] = await exited;
      clearTimeout(timeout);
      assert.equal(
        code,
        0,
        `Readiness preceded shutdown handlers: ${String(signal)}`,
      );
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("backup configuration failure leaves health available and emits only a safe outcome", {
  timeout: 10000,
}, async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [main], {
    env: { ...f.env, CONTEXT_BACKUP_TARGET: "s3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  try {
    for (let i = 0; i < 200 && !output.includes("\n"); i++) await delay(20);
    const event = JSON.parse(output.trim());
    assert.equal(event.event, "listening");
    assert.deepEqual(
      await (await fetch(`http://127.0.0.1:${event.port}/health`)).json(),
      { status: "ok" },
    );
    assert.deepEqual(JSON.parse(errors.trim()), {
      event: "backup",
      outcome: "failed",
      stage: "configuration",
    });
  } finally {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [code] = await exited;
    clearTimeout(timeout);
    await rm(f.directory, { recursive: true, force: true });
    assert.equal(code, 0);
  }
});
