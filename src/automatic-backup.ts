import { runEvalAfterBackup } from "./automatic-eval.js";
import { readBackupConfig } from "./backup-config.js";
import { BackupRunner, readBackupStatus } from "./backup-runner.js";
import { type BackupClock, startBackupScheduler } from "./backup-scheduler.js";
import { createBackupTarget } from "./backup-transports.js";

export async function startAutomaticBackups(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  clock?: BackupClock,
) {
  try {
    const config = readBackupConfig(env);
    const runner = new BackupRunner(
      { ...config, databasePath },
      createBackupTarget(config.target, config.timeoutMs),
    );
    const previous = await readBackupStatus(config.directory).catch(
      () => undefined,
    );
    return startBackupScheduler(
      config,
      async (day) => {
        const status = await runner.run(day);
        console.log(JSON.stringify({ event: "backup", ...status }));
        if (status.outcome === "busy") return false;
        await runEvalAfterBackup(databasePath, env);
        return true;
      },
      previous?.outcome === "running" ? undefined : previous?.lastScheduledDate,
      clock,
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "backup",
        outcome: "failed",
        stage: "configuration",
      }),
    );
    return { async stop() {} };
  }
}
