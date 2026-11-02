import assert from "node:assert/strict";
import { test } from "node:test";
import { readBackupConfig } from "../src/backup-config.js";

test("nightly local defaults and explicit off-host configuration fail closed", () => {
  const defaults = readBackupConfig({});
  assert.equal(defaults.at, "03:30");
  assert.equal(defaults.keep, 7);
  assert.deepEqual(defaults.target, { kind: "none" });
  assert.equal(readBackupConfig({ CONTEXT_BACKUP_AT: "off" }).at, "off");
  for (const env of [
    { CONTEXT_BACKUP_AT: "24:00" },
    { CONTEXT_BACKUP_KEEP: "0" },
    { CONTEXT_BACKUP_TIMEZONE: "invalid/zone" },
    { CONTEXT_BACKUP_TARGET: "other" },
    { CONTEXT_BACKUP_TARGET: "s3" },
    { CONTEXT_BACKUP_TARGET: "sftp" },
    { CONTEXT_BACKUP_DIR: " " },
  ])
    assert.throws(() => readBackupConfig(env));
  const s3 = {
    CONTEXT_BACKUP_TARGET: "s3",
    CONTEXT_BACKUP_S3_ENDPOINT: "https://s3.example.invalid",
    CONTEXT_BACKUP_S3_REGION: "us-east-1",
    CONTEXT_BACKUP_S3_BUCKET: "fictional-backups",
    CONTEXT_BACKUP_S3_ACCESS_KEY: "fictional-key",
    CONTEXT_BACKUP_S3_SECRET_KEY: "fictional-secret",
  };
  assert.equal(readBackupConfig(s3).target.kind, "s3");
  assert.throws(() =>
    readBackupConfig({
      ...s3,
      CONTEXT_BACKUP_S3_ENDPOINT: "http://s3.example.invalid",
    }),
  );
  assert.throws(() =>
    readBackupConfig({
      ...s3,
      CONTEXT_BACKUP_S3_ENDPOINT: "https://user:pass@s3.example.invalid",
    }),
  );
});
