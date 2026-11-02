import { readBackupConfig } from "../src/backup-config.js";
import { BackupRunner, readBackupStatus } from "../src/backup-runner.js";
import { createBackupTarget } from "../src/backup-transports.js";

try {
  process.umask(0o077);
  const [operation = "run", ...extra] = process.argv.slice(2);
  if (extra.length || !["run", "status"].includes(operation))
    throw new Error("Expected run|status");
  const config = readBackupConfig(process.env);
  if (operation === "status") {
    const status = await readBackupStatus(config.directory);
    console.log(JSON.stringify(status ?? { outcome: "never_run" }));
    if (status?.outcome !== "success") process.exitCode = 1;
  } else {
    const runner = new BackupRunner(
      {
        ...config,
        databasePath: process.env.CONTEXT_DB_PATH ?? "./data/context.db",
      },
      createBackupTarget(config.target, config.timeoutMs),
    );
    const status = await runner.run();
    console.log(JSON.stringify(status));
    if (status.outcome !== "success") process.exitCode = 1;
  }
} catch {
  console.error(
    "Backup operation failed; check configuration, paths and permissions",
  );
  process.exitCode = 1;
}
