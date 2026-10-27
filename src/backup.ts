import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function check(database: DatabaseSync): void {
  if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  database.prepare("SELECT id, scope, checksum FROM sources LIMIT 1").get();
}

export async function backupDatabase(
  source: string,
  destination: string,
): Promise<void> {
  if (resolve(source) === resolve(destination))
    throw new Error("Use a separate backup file");
  const database = new DatabaseSync(source, { readOnly: true });
  let created = false;
  try {
    check(database);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const file = await open(destination, "wx", 0o600);
    created = true;
    await file.close();
    await backup(database, destination);
  } catch (error) {
    if (created) await rm(destination, { force: true });
    throw error;
  } finally {
    database.close();
  }
}

// Offline only: restore never overwrites an existing database or its WAL files.
export async function restoreDatabase(
  source: string,
  destination: string,
): Promise<void> {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    check(database);
  } finally {
    database.close();
  }
  for (const path of [
    destination,
    `${destination}-wal`,
    `${destination}-shm`,
  ]) {
    try {
      const file = await open(path, "r");
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Restore destination must be absent, including sidecars");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
}
