import { startAutomaticBackups } from "./automatic-backup.js";
import { readConfig } from "./config.js";
import { startService } from "./server.js";

try {
  const config = readConfig(process.env);
  const service = await startService(config);
  const backups = await startAutomaticBackups(config.databasePath, process.env);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void backups
      .stop()
      .then(() => service.close())
      .catch(() => {
        console.error("Context shutdown failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(JSON.stringify({ event: "listening", ...service.address }));
} catch {
  // Do not print raw errors: SQLite errors can contain file paths or inputs.
  console.error(
    "Context startup failed; check authentication mode, port and database path",
  );
  process.exitCode = 1;
}
