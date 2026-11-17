import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { identifierSchema, scopeSchema } from "./contracts.js";
import { captureMaterialSchema } from "./materials.js";
import { rememberProjectsSchema } from "./projects.js";
import { SourceStore } from "./store.js";

const usage =
  "Usage: context remember [--area <area>] [--project <id>] [--kind note] [--idempotency-key <key>] [text]";

function areas(env: NodeJS.ProcessEnv): string[] {
  const list = (env.CONTEXT_AREAS ?? "personal").split(",");
  if (list.length > 8 || new Set(list).size !== list.length)
    throw new Error("Invalid configured areas");
  try {
    for (const area of list) scopeSchema.parse(area);
  } catch {
    throw new Error("Invalid configured areas");
  }
  return list;
}

async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (value.length > 9000) throw new Error("Text is too long");
  }
  return value.replace(/\r?\n$/, "");
}

/** Owner CLI for the same capture path as MCP remember. */
export async function rememberCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let areaFlag: string | undefined;
  let projects: string[] = [];
  let kind = "note";
  let idempotencyKey: string | undefined;
  let text: string | undefined;
  try {
    const parsed = parseArgs({
      args,
      options: {
        area: { type: "string" },
        project: { type: "string", multiple: true },
        kind: { type: "string" },
        "idempotency-key": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    areaFlag = parsed.values.area;
    projects = parsed.values.project ?? [];
    kind = parsed.values.kind ?? "note";
    idempotencyKey = parsed.values["idempotency-key"];
    if (parsed.positionals.length) text = parsed.positionals.join(" ").trim();
  } catch {
    throw new Error(usage);
  }
  if (kind !== "note")
    throw new Error(
      "kind must be note. Decisions are distilled from sources; this command stores a note.",
    );
  if (!text) {
    if (process.stdin.isTTY) throw new Error(usage);
    text = (await readStdin()).trim();
  }
  if (!text) throw new Error(usage);
  const configured = areas(env);
  let area = areaFlag;
  if (!area) {
    if (configured.includes("inbox")) area = "inbox";
    else if (configured.length === 1) area = configured[0];
  }
  if (!area || !configured.includes(area)) throw new Error("Unknown area");
  const path = env.CONTEXT_DB_PATH ?? "./data/context.db";
  if (!path.trim() || path === ":memory:")
    throw new Error("Persistent database required");
  const store = new SourceStore(path);
  try {
    if (projects.length) rememberProjectsSchema.parse(projects);
    for (const id of projects)
      if (!store.hasProject(id)) throw new Error(`Unknown project: ${id}`);
    const key =
      idempotencyKey ??
      `cli.${createHash("sha256")
        .update(JSON.stringify([area, [...projects].sort(), text]))
        .digest("hex")
        .slice(0, 32)}`;
    const saved = store.captureMaterial(
      captureMaterialSchema.parse({
        version: 1,
        text,
        origin: "cli:owner",
        scope: scopeSchema.parse(area),
        idempotencyKey: identifierSchema.parse(key),
        metadata: { type: "note" },
      }),
      undefined,
      projects.length ? projects : undefined,
    );
    process.stdout.write(
      `${JSON.stringify({
        id: saved.material.source.id,
        duplicate: saved.duplicate,
        scope: area,
        projects,
      })}\n`,
    );
  } catch (error) {
    if (error instanceof ZodError)
      throw new Error(
        "Invalid remember arguments. Text must be 1–8192 characters of well-formed Unicode.",
      );
    throw error;
  } finally {
    store.close();
  }
}
