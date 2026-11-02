import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { type PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { BackupTargetConfig } from "../src/backup-config.js";
import { createBackupTarget } from "../src/backup-transports.js";

async function fixture() {
  await mkdir(join(process.cwd(), ".output"), { recursive: true });
  const directory = await mkdtemp(
    join(process.cwd(), ".output/transport-test-"),
  );
  const path = join(directory, "fixture.db");
  const bytes = Buffer.from("fictional transport fixture");
  await writeFile(path, bytes);
  return {
    directory,
    bytes,
    file: {
      path,
      name: "fixture.db",
      size: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

test("S3 sends a streaming object with the configured key and checksum metadata", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  let sent = false;
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: PutObjectCommand) => {
      assert.equal(command.input.Bucket, "fictional-backups");
      assert.equal(command.input.Key, "daily/fixture.db");
      assert.deepEqual(command.input.Metadata, { sha256: f.file.checksum });
      assert.equal(command.input.ContentLength, f.bytes.length);
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as AsyncIterable<Buffer>)
        chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), f.bytes);
      sent = true;
      return {};
    },
  );
  await createBackupTarget(
    {
      kind: "s3",
      endpoint: "https://s3.example.invalid",
      region: "us-east-1",
      bucket: "fictional-backups",
      prefix: "daily/",
      accessKeyId: "fictional",
      secretAccessKey: "fictional",
    },
    1000,
  ).upload(f.file);
  assert.equal(sent, true);
});

test("SFTP pins the host key, streams a private partial file, checks size, and publishes by rename", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config: BackupTargetConfig = {
    kind: "sftp",
    host: "sftp.example.invalid",
    port: 22,
    username: "fictional",
    privateKeyPath: f.file.path,
    remoteDirectory: "/backups",
    hostKeySha256: "a".repeat(64),
  };
  const chunks: Buffer[] = [];
  let renamed = false;
  let stall = false;
  const sftp = {
    createWriteStream(path: string, options: { mode: number }) {
      assert.equal(path, "/backups/fixture.db.part");
      assert.equal(options.mode, 0o600);
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
    },
    stat(
      _path: string,
      callback: (error: Error | undefined, stats: { size: number }) => void,
    ) {
      if (!stall) callback(undefined, { size: f.bytes.length });
    },
    rename(from: string, to: string, callback: (error?: Error) => void) {
      assert.equal(from, "/backups/fixture.db.part");
      assert.equal(to, "/backups/fixture.db");
      renamed = true;
      callback();
    },
  };
  t.mock.method(
    Client.prototype,
    "connect",
    function (this: Client, options: ConnectConfig) {
      assert.equal(options.hostHash, "sha256");
      const verify = options.hostVerifier as (hash: string) => boolean;
      assert.equal(verify("a".repeat(64)), true);
      assert.equal(verify("b".repeat(64)), false);
      queueMicrotask(() => this.emit("ready"));
      return this;
    },
  );
  t.mock.method(
    Client.prototype,
    "sftp",
    (callback: (error: Error | undefined, sftp: SFTPWrapper) => void) => {
      callback(undefined, sftp as unknown as SFTPWrapper);
    },
  );
  await createBackupTarget(config, 1000).upload(f.file);
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  assert.equal(renamed, true);
  stall = true;
  // A server that never answers STAT must not block future nightly runs.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(createBackupTarget(config, 50).upload(f.file));
  } finally {
    clearTimeout(keepAlive);
  }
});
