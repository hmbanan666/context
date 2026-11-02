import { once } from "node:events";
import { createReadStream } from "node:fs";
import { parseArgs } from "node:util";
import { scopeSchema } from "../src/contracts.js";
import { importJsonl } from "../src/imports.js";
import { SourceStore } from "../src/store.js";

export async function runImport(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string" },
      area: { type: "string" },
      file: { type: "string" },
    },
    strict: true,
  });
  if (!values.source) throw new Error("Source is required");
  const areas = (process.env.CONTEXT_AREAS ?? "personal").split(",");
  if (areas.length > 8 || new Set(areas).size !== areas.length)
    throw new Error("Invalid configured areas");
  for (const area of areas) scopeSchema.parse(area);
  const path = process.env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  const input =
    values.file && values.file !== "-"
      ? createReadStream(values.file)
      : process.stdin;
  const store = new SourceStore(path);
  try {
    const summary = await importJsonl(
      store,
      input,
      {
        source: values.source,
        ...(values.area === undefined ? {} : { area: values.area }),
        areas,
      },
      async (result) => {
        if (!process.stdout.write(`${JSON.stringify(result)}\n`))
          await once(process.stdout, "drain");
      },
    );
    if (summary.rejected) process.exitCode = 2;
  } finally {
    store.close();
    if (input !== process.stdin) input.destroy();
  }
}
