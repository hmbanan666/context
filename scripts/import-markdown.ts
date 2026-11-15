import { once } from "node:events";
import { parseArgs } from "node:util";
import { scopeSchema } from "../src/contracts.js";
import {
  importMarkdown,
  type MarkdownImportResult,
} from "../src/import-markdown.js";
import { SourceStore } from "../src/store.js";

const usage =
  "Usage: context import markdown <dir> [--area <area>] [--project <id>]";

export async function runMarkdownImport(args: string[]): Promise<void> {
  let directory: string | undefined;
  let area: string | undefined;
  let project: string | undefined;
  try {
    const parsed = parseArgs({
      args,
      options: {
        area: { type: "string" },
        project: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 1) throw new Error(usage);
    directory = parsed.positionals[0];
    area = parsed.values.area;
    project = parsed.values.project;
  } catch {
    throw new Error(usage);
  }
  if (!directory) throw new Error(usage);
  const areas = (process.env.CONTEXT_AREAS ?? "personal").split(",");
  if (areas.length > 8 || new Set(areas).size !== areas.length)
    throw new Error("Invalid configured areas");
  for (const configured of areas) scopeSchema.parse(configured);
  const path = process.env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  const store = new SourceStore(path);
  try {
    const summary = await importMarkdown(
      store,
      directory,
      {
        areas,
        ...(area === undefined ? {} : { area }),
        ...(project === undefined ? {} : { project }),
      },
      async (result: MarkdownImportResult) => {
        if (!process.stdout.write(`${JSON.stringify(result)}\n`))
          await once(process.stdout, "drain");
      },
    );
    if (summary.rejected) process.exitCode = 2;
  } finally {
    store.close();
  }
}
