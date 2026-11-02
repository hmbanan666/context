import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";
import { restoreDatabase } from "../src/backup.js";
import { BackupRunner } from "../src/backup-runner.js";
import { SourceStore } from "../src/store.js";

before(async () => {
  await mkdir(join(process.cwd(), ".output"), { recursive: true });
});

test("local backup is verified, private, and restores exact originals and retry identity", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const backups = join(directory, "backups");
  const store = new SourceStore(databasePath);
  const input = {
    version: 1 as const,
    text: "Fictional amber heron",
    origin: "fixture:backup",
    scope: "backup",
    idempotencyKey: "nightly-1",
  };
  try {
    const saved = store.capture(input);
    const runner = new BackupRunner(
      { databasePath, directory: backups, keep: 7 },
      { kind: "none", async upload() {} },
    );
    const result = await runner.run();
    assert.equal(result.outcome, "success");
    assert.equal(result.copy, "local_only");
    assert.match(result.checksum ?? "", /^[a-f0-9]{64}$/);
    assert.ok(result.size && result.size > 0);
    const snapshot = join(backups, result.file ?? "missing");
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(await readFile(join(backups, "status.json"), "utf8")),
      result,
    );
    const restored = join(directory, "restored.db");
    await restoreDatabase(snapshot, restored);
    const clone = new SourceStore(restored);
    try {
      assert.deepEqual(clone.search("amber heron", input.scope, 10), [
        saved.source,
      ]);
      assert.deepEqual(clone.capture(input), { ...saved, duplicate: true });
    } finally {
      clone.close();
    }
    assert.equal(
      (await readdir(backups)).some((name) =>
        name.startsWith(".context-backup-"),
      ),
      false,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed off-host copies keep bounded local recovery files and never disclose errors", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const backups = join(directory, "backups");
  const store = new SourceStore(databasePath);
  try {
    const files = new Map<string, Buffer>();
    let fail = false;
    const runner = new BackupRunner(
      { databasePath, directory: backups, keep: 2 },
      {
        kind: "s3",
        async upload(file) {
          if (fail)
            throw new Error("fictional private content and credentials");
          files.set(file.name, await readFile(file.path));
        },
      },
    );
    const first = await runner.run("2026-11-01");
    assert.equal(first.copy, "uploaded");
    assert.equal(files.size, 1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(backups, "owner-archive.db"),
      "fictional unrelated file",
    );
    fail = true;
    for (let i = 0; i < 3; i++) {
      const failed = await runner.run();
      assert.equal(failed.outcome, "failed");
      assert.equal(failed.stage, "upload");
      assert.equal(failed.lastScheduledDate, "2026-11-01");
      assert.equal(JSON.stringify(failed).includes("fictional private"), false);
    }
    assert.equal(
      (await readdir(backups)).filter((name) => /^context-.*\.db$/.test(name))
        .length,
      2,
    );
    assert.equal(
      await readFile(join(backups, "owner-archive.db"), "utf8"),
      "fictional unrelated file",
    );
    fail = false;
    assert.equal((await runner.run()).outcome, "success");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduled and manual runs cannot race retention while an upload is active", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const store = new SourceStore(databasePath);
  let release = () => {};
  let entered = () => {};
  const uploading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = {
    databasePath,
    directory: join(directory, "backups"),
    keep: 1,
  };
  const runner = new BackupRunner(options, {
    kind: "sftp",
    async upload() {
      entered();
      await gate;
    },
  });
  const active = runner.run();
  try {
    await uploading;
    assert.equal(runner.run(), active);
    const competing = new BackupRunner(options, {
      kind: "none",
      async upload() {},
    });
    assert.equal((await competing.run()).outcome, "busy");
    release();
    assert.equal((await active).outcome, "success");
    assert.equal((await competing.run()).outcome, "success");
  } finally {
    release();
    await active;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt source cannot replace a good snapshot or be uploaded", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const store = new SourceStore(databasePath);
  store.close();
  let uploads = 0;
  const runner = new BackupRunner(
    { databasePath, directory: join(directory, "backups"), keep: 1 },
    {
      kind: "s3",
      async upload() {
        uploads++;
      },
    },
  );
  try {
    assert.equal((await runner.run()).outcome, "success");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(databasePath, "fictional corrupt SQLite");
    const failed = await runner.run();
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.stage, "snapshot");
    assert.equal(uploads, 1);
    assert.equal(
      (await readdir(join(directory, "backups"))).filter((name) =>
        /^context-.*\.db$/.test(name),
      ).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention keeps the new verified snapshot even when the wall clock moves backward", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const backups = join(directory, "backups");
  const store = new SourceStore(databasePath);
  store.close();
  const runner = new BackupRunner(
    { databasePath, directory: backups, keep: 1 },
    {
      kind: "s3",
      async upload(file) {
        await stat(file.path);
      },
    },
  );
  try {
    const first = await runner.run();
    const { rename } = await import("node:fs/promises");
    await rename(
      join(backups, first.file ?? "missing"),
      join(
        backups,
        `context-20990101T000000000Z-00000000-0000-0000-0000-000000000000.db`,
      ),
    );
    const second = await runner.run();
    assert.equal(second.outcome, "success");
    await stat(join(backups, second.file ?? "missing"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later run removes abandoned verification copies after a process crash", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const backups = join(directory, "backups");
  const store = new SourceStore(databasePath);
  store.close();
  try {
    await mkdir(backups);
    const abandoned = await mkdtemp(join(backups, ".context-backup-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(abandoned, "snapshot.db"),
      "fictional incomplete snapshot",
    );
    await mkdir(join(backups, "owner-staging"));
    const runner = new BackupRunner(
      { databasePath, directory: backups, keep: 1 },
      { kind: "none", async upload() {} },
    );
    assert.equal((await runner.run()).outcome, "success");
    assert.equal(
      (await readdir(backups)).some((name) =>
        name.startsWith(".context-backup-"),
      ),
      false,
    );
    assert.equal(
      (await stat(join(backups, "owner-staging"))).isDirectory(),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a damaged lock is reported as failure, not another active backup", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(directory, ".backup-lock.db"),
      "fictional damaged lock",
    );
    const runner = new BackupRunner(
      { databasePath: join(directory, "unused.db"), directory, keep: 1 },
      { kind: "none", async upload() {} },
    );
    assert.equal((await runner.run()).outcome, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clock correction during upload cannot corrupt persisted backup status", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-test-"));
  const databasePath = join(directory, "source.db");
  const store = new SourceStore(databasePath);
  store.close();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const backups = join(directory, "backups");
  const runner = new BackupRunner(
    { databasePath, directory: backups, keep: 1 },
    {
      kind: "sftp",
      async upload() {
        now -= 60000;
      },
    },
  );
  try {
    const status = await runner.run();
    assert.equal(status.outcome, "success");
    assert.ok(status.durationMs >= 0);
    const { readBackupStatus } = await import("../src/backup-runner.js");
    assert.deepEqual(await readBackupStatus(backups), status);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nightly off-host copy restores every built-in auth table with sources and denied rights", async () => {
  const { AuthStore } = await import("../src/auth-store.js");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(process.cwd(), ".output/backup-auth-"));
  const databasePath = join(directory, "context.db");
  const sources = new SourceStore(databasePath);
  const auth = new AuthStore(databasePath, ["personal", "garden"]);
  const resource = "https://context.example/mcp";
  const password = "Fictional recovery password 123";
  try {
    const input = {
      version: 1 as const,
      text: "Fictional copper finch",
      origin: "fixture:auth-backup",
      scope: "garden",
      idempotencyKey: "auth-backup-1",
    };
    const saved = sources.capture(input);
    await auth.initOwner(password);
    const passkey = {
      id: "fictional-passkey",
      publicKey: Buffer.from("fictional public-key fixture").toString(
        "base64url",
      ),
      counter: 4,
    };
    auth.savePasskey(passkey);
    const registered = auth.register(
      "fictional-browser",
      ["https://client.example/callback"],
      true,
      "client_secret_basic",
    );
    const grants = { read: ["garden"], write: [], process: [] };
    const allowed = auth.createCliToken(
      "fictional-reader",
      grants,
      null,
      3600,
      resource,
    );
    const revoked = auth.createCliToken(
      "fictional-revoked",
      grants,
      null,
      3600,
      resource,
    );
    auth.revokeToken(revoked.id);
    const sessionData = {
      csrf: "fictional-csrf",
      password: false,
      authenticated: false,
    };
    const session = auth.newSession(sessionData);
    let uploaded: Buffer | undefined;
    const runner = new BackupRunner(
      { databasePath, directory: join(directory, "backups"), keep: 1 },
      {
        kind: "s3",
        async upload(file) {
          uploaded = await readFile(file.path);
        },
      },
    );
    const status = await runner.run("2026-11-02");
    assert.equal(status.outcome, "success");
    assert.equal(status.copy, "uploaded");
    assert.ok(uploaded);
    for (const value of [
      password,
      allowed.token,
      revoked.token,
      registered.clientSecret,
      session,
    ]) {
      assert.ok(value);
      assert.equal(uploaded.includes(Buffer.from(value)), false);
    }
    const downloaded = join(directory, "download.db");
    const restored = join(directory, "restored.db");
    await writeFile(downloaded, uploaded, { mode: 0o600 });
    await restoreDatabase(downloaded, restored);
    const restoredSources = new SourceStore(restored);
    const restoredAuth = new AuthStore(restored, ["personal", "garden"]);
    try {
      assert.deepEqual(restoredSources.capture(input), {
        ...saved,
        duplicate: true,
      });
      assert.deepEqual(restoredSources.search("copper finch", "garden", 10), [
        saved.source,
      ]);
      assert.equal(await restoredAuth.checkPassword(password), true);
      assert.equal(
        await restoredAuth.checkPassword("Fictional wrong password"),
        false,
      );
      assert.deepEqual(restoredAuth.passkeys(), [passkey]);
      assert.deepEqual(restoredAuth.listClients(), auth.listClients());
      assert.equal(
        restoredAuth.authenticateClient(
          registered.client.id,
          "client_secret_basic",
          registered.clientSecret,
        ).id,
        registered.client.id,
      );
      assert.throws(() =>
        restoredAuth.authenticateClient(
          registered.client.id,
          "client_secret_basic",
          "fictional-wrong-secret",
        ),
      );
      assert.deepEqual(
        restoredAuth.access(allowed.token, resource).grants,
        grants,
      );
      assert.throws(() => restoredAuth.access(revoked.token, resource));
      assert.deepEqual(restoredAuth.session(session), sessionData);
    } finally {
      restoredAuth.close();
      restoredSources.close();
    }
  } finally {
    auth.close();
    sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});
