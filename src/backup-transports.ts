import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client, type SFTPWrapper } from "ssh2";
import type { BackupTargetConfig } from "./backup-config.js";
import type { BackupTarget } from "./backup-target.js";

export function createBackupTarget(
  config: BackupTargetConfig,
  timeoutMs: number,
): BackupTarget {
  if (config.kind === "none") return { kind: "none", async upload() {} };
  if (config.kind === "s3")
    return {
      kind: "s3",
      async upload(file) {
        const client = new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
          maxAttempts: 1,
          requestChecksumCalculation: "WHEN_REQUIRED",
          requestHandler: {
            connectionTimeout: Math.min(timeoutMs, 10000),
            requestTimeout: timeoutMs,
          },
        });
        const body = createReadStream(file.path);
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: `${config.prefix.replace(/\/*$/, "")}${config.prefix ? "/" : ""}${file.name}`,
              Body: body,
              ContentLength: file.size,
              ContentType: "application/vnd.sqlite3",
              Metadata: { sha256: file.checksum },
            }),
            { abortSignal: AbortSignal.timeout(timeoutMs) },
          );
        } finally {
          body.destroy();
          client.destroy();
        }
      },
    };
  return {
    kind: "sftp",
    async upload(file) {
      const client = new Client();
      const controller = new AbortController();
      const signal = controller.signal;
      let fail: (error: Error) => void = () => {};
      const failure = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      const timeout = setTimeout(() => {
        controller.abort();
        fail(new Error("SFTP deadline exceeded"));
        client.destroy();
      }, timeoutMs);
      client.on("error", fail);
      client.once("close", () => fail(new Error("SFTP closed")));
      const transfer = async () => {
        const privateKey = await readFile(config.privateKeyPath);
        signal.throwIfAborted();
        const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
          client.once("error", reject);
          client.once("close", () => reject(new Error("SFTP closed")));
          client.once("ready", () =>
            client.sftp((error, session) =>
              error ? reject(error) : resolve(session),
            ),
          );
          client.connect({
            host: config.host,
            port: config.port,
            username: config.username,
            privateKey,
            hostHash: "sha256",
            hostVerifier: (hash: string) =>
              hash === config.hostKeySha256.toLowerCase(),
            readyTimeout: Math.min(timeoutMs, 10000),
            keepaliveInterval: 10000,
            keepaliveCountMax: 2,
          });
        });
        signal.throwIfAborted();
        const destination = posix.join(config.remoteDirectory, file.name);
        const temporary = `${destination}.part`;
        await pipeline(
          createReadStream(file.path),
          sftp.createWriteStream(temporary, { flags: "w", mode: 0o600 }),
          { signal },
        );
        const info = await new Promise<{ size: number }>((resolve, reject) =>
          sftp.stat(temporary, (error, stats) =>
            error ? reject(error) : resolve(stats),
          ),
        );
        if (info.size !== file.size) throw new Error("SFTP size mismatch");
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) =>
          sftp.rename(temporary, destination, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      };
      try {
        await Promise.race([transfer(), failure]);
      } finally {
        clearTimeout(timeout);
        controller.abort();
        client.destroy();
      }
    },
  };
}
