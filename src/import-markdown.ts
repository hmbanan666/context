import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { maxImportTextLength } from "./import-format.js";
import { projectIdSchema } from "./projects.js";
import { redact, redactMetadata } from "./redaction.js";
import type { SourceStore } from "./store.js";

// Same byte cap the GitHub collector uses before it keeps a file.
export const maxMarkdownBytes = 256 * 1024;
export const markdownImportSource = "markdown";

const frontMatterPattern = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const headingPattern = /^#{1,6}[ \t]+(.+?)\s*#*\s*$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const allowedKeys = new Set(["title", "project", "date", "tags"]);

export interface MarkdownImportOptions {
  readonly areas: readonly string[];
  readonly area?: string;
  readonly project?: string;
}

export interface MarkdownImportItem {
  readonly type: "item";
  readonly path: string;
  readonly status: "added" | "updated" | "skipped" | "rejected";
  readonly source_id?: string;
  readonly reason?: string;
}

export interface MarkdownImportSummary {
  readonly type: "summary";
  added: number;
  updated: number;
  skipped: number;
  rejected: number;
}

export type MarkdownImportResult = MarkdownImportItem | MarkdownImportSummary;

interface ParsedNote {
  readonly title: string;
  readonly body: string;
  readonly project?: string;
  readonly createdAt?: string;
  readonly tags?: string;
}

export function splitMarkdownBody(
  text: string,
  limit = maxImportTextLength,
): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (/[\uDC00-\uDFFF]/u.test(rest[cut] ?? "")) cut -= 1;
    const paragraph = rest.lastIndexOf("\n\n", cut);
    if (paragraph >= Math.floor(limit / 2)) cut = paragraph;
    if (cut < 1) cut = Math.min(limit, rest.length);
    const piece = rest.slice(0, cut);
    if (piece.trim()) parts.push(piece);
    rest = rest.slice(cut);
    if (rest.startsWith("\n\n")) rest = rest.slice(2);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

function fileKey(root: string, file: string): string {
  const key = relative(root, file).split(sep).join("/");
  if (
    !key ||
    key === ".." ||
    key.startsWith("../") ||
    key.startsWith("/") ||
    key.length > 1024 ||
    /\p{Cc}/u.test(key)
  )
    throw new Error("invalid_path");
  return key;
}

async function markdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
    }
  };
  await walk(root);
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

function headingTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    const match = headingPattern.exec(line);
    const title = match?.[1]?.trim();
    if (title) return title;
  }
  return undefined;
}

function parseDate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("invalid_front_matter");
    return value.toISOString();
  }
  if (typeof value !== "string") throw new Error("invalid_front_matter");
  const text = dayPattern.test(value) ? `${value}T00:00:00Z` : value;
  const parsed = z.iso.datetime({ offset: true }).safeParse(text);
  if (!parsed.success) throw new Error("invalid_front_matter");
  return parsed.data;
}

function parseTags(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 32) throw new Error("invalid_front_matter");
  if (!list.length) return undefined;
  const tags = list.map((tag) => {
    if (typeof tag !== "string") throw new Error("invalid_front_matter");
    const trimmed = tag.trim();
    if (!trimmed || trimmed.length > 64 || /\p{Cc}/u.test(trimmed))
      throw new Error("invalid_front_matter");
    return trimmed;
  });
  const joined = tags.join(",");
  if (joined.length > 2048) throw new Error("invalid_front_matter");
  return joined;
}

function parseNote(raw: string, filename: string): ParsedNote {
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let data: Record<string, unknown> | undefined;
  const front = frontMatterPattern.exec(text);
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    if (!front) throw new Error("invalid_front_matter");
    const document = parseDocument(front[1] ?? "", { uniqueKeys: true });
    if (document.errors.length) throw new Error("invalid_front_matter");
    const parsed = document.toJS({ maxAliasCount: 0 });
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid_front_matter");
      data = parsed as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (!allowedKeys.has(key)) throw new Error("invalid_front_matter");
      }
    }
    text = text.slice(front[0].length);
  }
  const titleValue = data?.title;
  if (titleValue !== undefined && typeof titleValue !== "string")
    throw new Error("invalid_front_matter");
  const frontTitle = titleValue?.trim();
  if (frontTitle !== undefined && (!frontTitle || frontTitle.length > 256))
    throw new Error("invalid_front_matter");
  const projectValue = data?.project;
  if (projectValue !== undefined && typeof projectValue !== "string")
    throw new Error("invalid_front_matter");
  if (
    projectValue !== undefined &&
    !projectIdSchema.safeParse(projectValue).success
  )
    throw new Error("invalid_front_matter");
  const fromHeading = headingTitle(text);
  const title =
    frontTitle ||
    (fromHeading && fromHeading.length <= 256 ? fromHeading : undefined) ||
    filename;
  if (!title.trim() || title.length > 256)
    throw new Error("invalid_front_matter");
  const createdAt = parseDate(data?.date);
  const tags = parseTags(data?.tags);
  return {
    title,
    body: text,
    ...(projectValue ? { project: projectValue } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(tags ? { tags } : {}),
  };
}

function resolveArea(options: MarkdownImportOptions): string {
  if (options.area) {
    if (!options.areas.includes(options.area)) throw new Error("Unknown area");
    return options.area;
  }
  if (options.areas.includes("inbox")) return "inbox";
  if (options.areas.length === 1) return options.areas[0] ?? "";
  throw new Error("Area is required");
}

export async function importMarkdown(
  store: SourceStore,
  directory: string,
  options: MarkdownImportOptions,
  emit: (result: MarkdownImportResult) => void | Promise<void> = () => {},
): Promise<MarkdownImportSummary> {
  const rootInfo = await stat(directory);
  if (!rootInfo.isDirectory()) throw new Error("Not a directory");
  const area = resolveArea(options);
  if (!area) throw new Error("Area is required");
  if (options.project !== undefined) {
    if (!projectIdSchema.safeParse(options.project).success)
      throw new Error("Unknown project");
    if (!store.hasProject(options.project)) throw new Error("Unknown project");
  }
  const summary: MarkdownImportSummary = {
    type: "summary",
    added: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
  };
  const reject = async (path: string, reason: string) => {
    summary.rejected += 1;
    await emit({ type: "item", path, status: "rejected", reason });
  };
  for (const file of await markdownFiles(directory)) {
    let key: string;
    try {
      key = fileKey(directory, file);
    } catch {
      await reject("invalid", "invalid_path");
      continue;
    }
    try {
      const info = await stat(file);
      if (info.size === 0 || info.size > maxMarkdownBytes) {
        await reject(key, info.size === 0 ? "empty" : "file_too_large");
        continue;
      }
      const bytes = await readFile(file);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        await reject(key, "invalid_utf8");
        continue;
      }
      if (redact(key) !== key) {
        await reject(key, "unsafe_identity");
        continue;
      }
      const filename = key.split("/").pop()?.replace(/\.md$/u, "") ?? key;
      const note = parseNote(decoded, filename);
      const project = note.project ?? options.project;
      if (project && !store.hasProject(project)) {
        await reject(key, "unknown_project");
        continue;
      }
      const body = redact(note.body);
      if (!body.trim()) {
        await reject(key, "empty");
        continue;
      }
      const title = redact(note.title).slice(0, 256);
      const parts = splitMarkdownBody(body).filter((part) => part.trim());
      if (
        !parts.length ||
        parts.some((part) => part.length > maxImportTextLength)
      ) {
        await reject(key, "empty");
        continue;
      }
      for (const [index, part] of parts.entries()) {
        const externalId = index === 0 ? key : `${key}#${index + 1}`;
        if (externalId.length > 1024) {
          await reject(externalId, "invalid_path");
          continue;
        }
        try {
          const saved = store.importMaterial(
            {
              version: 1,
              text: part,
              origin: `import:${markdownImportSource}`,
              scope: area,
              idempotencyKey: "import",
              metadata: {
                type: "document",
                title,
                ...(note.createdAt ? { createdAt: note.createdAt } : {}),
              },
            },
            {
              source: markdownImportSource,
              externalId,
              kind: "markdown",
              metadata: redactMetadata({
                path: key,
                ...(note.tags ? { tags: note.tags } : {}),
                ...(parts.length > 1 ? { chunk: String(index + 1) } : {}),
              }),
            },
            project ? [project] : undefined,
          );
          const status = saved.duplicate
            ? "skipped"
            : saved.changed
              ? "updated"
              : "added";
          summary[status] += 1;
          await emit({
            type: "item",
            path: externalId,
            status,
            source_id: saved.source.id,
          });
        } catch {
          await reject(externalId, "storage_failure_retryable");
        }
      }
    } catch (error) {
      const reason =
        error instanceof Error &&
        (error.message === "invalid_front_matter" ||
          error.message === "invalid_path")
          ? error.message
          : "invalid_front_matter";
      await reject(key, reason);
    }
  }
  await emit(summary);
  return summary;
}
