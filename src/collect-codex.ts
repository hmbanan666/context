import { createReadStream } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { collectedItem, truncate } from "./collector-output.js";
import type { ImportLine } from "./import-format.js";
import { boundedLines } from "./jsonl.js";
import { redact } from "./redaction.js";

export interface CodexOptions {
  sessions: string;
  tasks?: string;
}
export interface CollectorStats {
  skipped: number;
  errors: number;
}
const maxRolloutLineBytes = 8 * 1024 * 1024;

async function* sessionFiles(directory: string): AsyncGenerator<string> {
  for await (const entry of await opendir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

async function sessionItem(path: string): Promise<ImportLine | undefined> {
  let id = "",
    cwd = "",
    repo = "",
    created = "",
    ended = "",
    prompt = "",
    final = "";
  let truncated = false;
  const retain = (text: string) => {
    const safe = redact(text);
    if (safe.length > 3900) truncated = true;
    return truncate(safe, 3900);
  };
  for await (const line of boundedLines(
    createReadStream(path),
    maxRolloutLineBytes,
  )) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    const p = record(event.payload);
    if (event.type === "session_meta") {
      id = string(p.id) || string(p.session_id);
      cwd = string(p.cwd);
      repo = string(record(p.git).repository_url);
      created = string(p.timestamp) || string(event.timestamp);
    }
    if (event.type === "response_item" && p.type === "message") {
      const text = Array.isArray(p.content)
        ? p.content
            .map((c) => record(c))
            .filter((c) => c.type === "input_text" || c.type === "output_text")
            .map((c) => string(c.text))
            .join("\n")
        : "";
      if (
        p.role === "user" &&
        !prompt &&
        text.trim() &&
        !text.startsWith("# AGENTS.md instructions") &&
        !text.startsWith("<environment_context>")
      )
        prompt = retain(text);
      if (
        p.role === "assistant" &&
        (p.phase === "final_answer" ||
          p.phase === "final" ||
          p.channel === "final")
      ) {
        final = retain(text);
        ended = string(event.timestamp);
      }
    }
    // Older rollouts provide the final message on the completed task event.
    if (
      event.type === "event_msg" &&
      p.type === "task_complete" &&
      typeof p.last_agent_message === "string"
    ) {
      final = retain(p.last_agent_message);
      ended = string(event.timestamp);
    }
  }
  if (!id || !prompt || !final) return undefined;
  return collectedItem({
    id: `codex:${id}`,
    text: `Initial user prompt:\n${prompt}\n\nFinal agent message:\n${final}`,
    area: "projects",
    kind: "task-report",
    ...(created ? { created_at: created } : {}),
    metadata: {
      cwd: truncate(redact(cwd), 2048),
      repo: truncate(redact(repo), 2048),
      ...(ended ? { completed_at: ended } : {}),
      ...(truncated ? { truncated: "true" } : {}),
    },
  });
}

async function taskText(
  path: string,
): Promise<{ text: string; truncated: boolean; timestamp: string }> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Expected regular task file");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min(info.size, 1024 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const text = redact(bytes.subarray(0, bytesRead).toString("utf8"));
    return {
      text: truncate(text, 3900),
      truncated: info.size > bytes.length || text.length > 3900,
      timestamp: info.mtime.toISOString(),
    };
  } finally {
    await file.close();
  }
}

export async function* collectCodex(
  options: CodexOptions,
  stats: CollectorStats = { skipped: 0, errors: 0 },
): AsyncGenerator<ImportLine> {
  for await (const path of sessionFiles(options.sessions)) {
    try {
      const item = await sessionItem(path);
      if (item) yield item;
      else stats.skipped++;
    } catch {
      stats.errors++;
    }
  }
  if (!options.tasks) return;
  for await (const entry of await opendir(options.tasks)) {
    if (!entry.isDirectory()) continue;
    const path = join(options.tasks, entry.name);
    try {
      const prompt = await taskText(join(path, "prompt.txt"));
      const final = await taskText(join(path, "last.md"));
      if (!prompt.text.trim() || !final.text.trim()) {
        stats.skipped++;
        continue;
      }
      yield collectedItem({
        id: `codex-task:${entry.name}`,
        created_at: prompt.timestamp,
        text: `Initial user prompt:\n${prompt.text}\n\nFinal agent message:\n${final.text}`,
        area: "projects",
        kind: "task-report",
        metadata: {
          completed_at: final.timestamp,
          timestamp_basis: "file_mtime",
          ...(prompt.truncated || final.truncated ? { truncated: "true" } : {}),
        },
      });
    } catch (error) {
      if (record(error).code === "ENOENT") stats.skipped++;
      else stats.errors++;
    }
  }
}
