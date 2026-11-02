import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { backupDatabase, restoreDatabase, verifyDatabase } from "./backup.js";
import type { BackupFile, BackupTarget } from "./backup-target.js";

const statusSchema = z.object({
  outcome: z.enum(["running", "success", "failed", "busy"]),
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  target: z.enum(["none", "s3", "sftp"]),
  copy: z.enum(["pending", "local_only", "uploaded"]),
  stage: z.enum([
    "lock",
    "snapshot",
    "verify",
    "upload",
    "retention",
    "status",
    "complete",
  ]),
  file: z
    .string()
    .regex(/^context-\d{8}T\d{9}Z-[a-f0-9-]{36}\.db$/)
    .optional(),
  size: z.number().nonnegative().optional(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  lastScheduledDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type BackupStatus = z.infer<typeof statusSchema>;

export interface BackupOptions {
  readonly databasePath: string;
  readonly directory: string;
  readonly keep: number;
}

export async function readBackupStatus(
  directory: string,
): Promise<BackupStatus | undefined> {
  try {
    return statusSchema.parse(
      JSON.parse(await readFile(join(directory, "status.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Backup status unavailable");
  }
}

export class BackupRunner {
  private active: Promise<BackupStatus> | undefined;

  constructor(
    private readonly options: BackupOptions,
    private readonly target: BackupTarget,
  ) {
    if (!Number.isInteger(options.keep) || options.keep < 1)
      throw new Error("Invalid backup retention");
  }

  run(scheduledDate?: string): Promise<BackupStatus> {
    if (this.active) return this.active;
    this.active = this.execute(scheduledDate).finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async execute(scheduledDate?: string): Promise<BackupStatus> {
    const started = Date.now();
    const durationStart = performance.now();
    const status: BackupStatus = {
      outcome: "running",
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      target: this.target.kind,
      copy: "pending",
      stage: "lock",
    };
    let lock: DatabaseSync | undefined;
    let temporary: string | undefined;
    let locked = false;
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const lockPath = join(this.options.directory, ".backup-lock.db");
      await writeFile(lockPath, "", { flag: "ax", mode: 0o600 }).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        },
      );
      // An OS-backed SQLite lock also coordinates CLI runs and releases on crash.
      lock = new DatabaseSync(lockPath);
      try {
        lock.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code !== 5 && code !== 6) throw error;
        status.outcome = "busy";
        return status;
      }
      locked = true;
      const previous = await readBackupStatus(this.options.directory);
      const lastScheduledDate = scheduledDate ?? previous?.lastScheduledDate;
      if (lastScheduledDate) status.lastScheduledDate = lastScheduledDate;
      await this.saveStatus(status);
      status.stage = "snapshot";
      for (const entry of await readdir(this.options.directory, {
        withFileTypes: true,
      })) {
        const path = resolve(this.options.directory, entry.name);
        if (
          entry.isDirectory() &&
          /^\.context-backup-[a-zA-Z0-9]{6}$/.test(entry.name) &&
          !resolve(this.options.databasePath).startsWith(`${path}${sep}`)
        ) {
          await rm(path, { recursive: true, force: true });
        }
      }
      temporary = await mkdtemp(
        join(this.options.directory, ".context-backup-"),
      );
      const candidate = join(temporary, "snapshot.db");
      await backupDatabase(this.options.databasePath, candidate);
      status.stage = "verify";
      const restored = join(temporary, "restored.db");
      await restoreDatabase(candidate, restored);
      verifyDatabase(restored);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(candidate)) hash.update(chunk);
      const name = `context-${status.startedAt.replace(/[-:.]/g, "")}-${randomUUID()}.db`;
      const file: BackupFile = {
        path: join(this.options.directory, name),
        name,
        size: (await stat(candidate)).size,
        checksum: hash.digest("hex"),
      };
      await rename(candidate, file.path);
      status.file = name;
      status.size = file.size;
      status.checksum = file.checksum;
      status.stage = "retention";
      const snapshots = (
        await readdir(this.options.directory, { withFileTypes: true })
      )
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name !== file.name &&
            statusSchema.shape.file.unwrap().safeParse(entry.name).success &&
            resolve(this.options.directory, entry.name) !==
              resolve(this.options.databasePath),
        )
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const name of snapshots.slice(this.options.keep - 1))
        await rm(join(this.options.directory, name));
      status.stage = "upload";
      await this.target.upload(file);
      status.copy = this.target.kind === "none" ? "local_only" : "uploaded";
      status.outcome = "success";
      status.stage = "complete";
    } catch {
      // Never propagate database contents, paths, credentials or remote errors.
      status.outcome = "failed";
    } finally {
      if (temporary)
        await rm(temporary, { recursive: true, force: true }).catch(() => {
          status.outcome = "failed";
        });
      status.durationMs = Math.round(performance.now() - durationStart);
      if (locked) {
        await this.saveStatus(status).catch(() => {
          status.outcome = "failed";
          status.stage = "status";
        });
      }
      lock?.close();
    }
    return status;
  }

  private async saveStatus(status: BackupStatus): Promise<void> {
    const path = join(this.options.directory, ".status.tmp");
    await writeFile(path, JSON.stringify(status), { mode: 0o600 });
    await rename(path, join(this.options.directory, "status.json"));
  }
}
