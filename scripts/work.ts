import { readFile, stat } from "node:fs/promises";
import { KnowledgeStore } from "../src/knowledge.js";
import { SourceStore } from "../src/store.js";
import { applyWorkAuthorization, WorkStore } from "../src/work.js";

const [command, databasePath, ...args] = process.argv.slice(2);
let sources: SourceStore | undefined;
let knowledge: KnowledgeStore | undefined;
let work: WorkStore | undefined;
async function boundedFile(path: string): Promise<string> {
  if ((await stat(path)).size > 16384) throw new Error("File too large");
  const data = await readFile(path, "utf8");
  if (Buffer.byteLength(data) > 16384) throw new Error("File too large");
  return data;
}
try {
  if (
    !databasePath ||
    !["authorize", "sync", "context"].includes(command ?? "")
  )
    throw new Error("Invalid command");
  sources = new SourceStore(databasePath);
  knowledge = new KnowledgeStore(databasePath);
  work = new WorkStore(databasePath, sources, knowledge);
  if (command === "authorize") {
    const [publicKeyPath, receiptPath, ...extra] = args;
    if (!publicKeyPath || !receiptPath || extra.length)
      throw new Error("Expected TRUSTED_PUBLIC_KEY SIGNED_RECEIPT");
    const [key, receipt] = await Promise.all([
      boundedFile(publicKeyPath),
      boundedFile(receiptPath),
    ]);
    const result = applyWorkAuthorization(work, JSON.parse(receipt), key);
    console.log(
      JSON.stringify({ id: result.work.id, duplicate: result.duplicate }),
    );
  } else if (command === "sync") {
    const [scope, id, pullNumber, requestKey, ...extra] = args;
    if (
      !scope ||
      !id ||
      !pullNumber ||
      !/^[1-9][0-9]*$/.test(pullNumber) ||
      !requestKey ||
      extra.length
    )
      throw new Error("Expected SCOPE WORK_ID PR_NUMBER REQUEST_KEY");
    const result = await work.refresh(
      id,
      scope,
      Number(pullNumber),
      requestKey,
    );
    console.log(
      JSON.stringify({
        id: result.observation.id,
        error: result.observation.error,
        duplicate: result.duplicate,
        result: work.context(id, scope).result,
        deployment: "unverified",
      }),
    );
    if (result.observation.error) process.exitCode = 1;
  } else {
    const [scope, id, ...extra] = args;
    if (!scope || !id || extra.length)
      throw new Error("Expected SCOPE WORK_ID");
    // Context export is explicit; ordinary commands never log source content.
    console.log(JSON.stringify(work.context(id, scope)));
  }
} catch {
  console.error(
    "Work command failed; verify scoped intent, independent owner authorization and GitHub availability",
  );
  process.exitCode = 1;
} finally {
  work?.close();
  knowledge?.close();
  sources?.close();
}
