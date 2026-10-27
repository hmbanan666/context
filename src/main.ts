import { readConfig } from "./config.js";
import { startService } from "./server.js";

try {
  const service = await startService(readConfig(process.env));
  console.log(JSON.stringify({ event: "listening", ...service.address }));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void service.close().catch(() => {
      console.error("Context shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  // Do not print raw errors: SQLite errors can contain file paths or inputs.
  console.error(
    "Context startup failed; check authentication mode, port and database path",
  );
  process.exitCode = 1;
}
