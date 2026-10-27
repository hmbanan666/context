import { backupDatabase, restoreDatabase } from "../src/backup.js";

const [operation, source, destination, ...extra] = process.argv.slice(2);
try {
  if (
    !source ||
    !destination ||
    extra.length ||
    !["backup", "restore"].includes(operation ?? "")
  ) {
    throw new Error("Expected backup|restore SOURCE DESTINATION");
  }
  process.umask(0o077);
  if (operation === "backup") await backupDatabase(source, destination);
  else await restoreDatabase(source, destination);
  console.log("Database operation completed");
} catch {
  console.error(
    "Database operation failed; verify paths, permissions and offline restore requirements",
  );
  process.exitCode = 1;
}
