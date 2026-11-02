import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { collectedItem } from "./collector-output.js";
import type { ImportLine } from "./import-format.js";

export interface GithubApi {
  get(path: string): Promise<unknown>;
}
export class GithubApiError extends Error {
  constructor(readonly status?: number) {
    super("GitHub request failed");
  }
}
const exec = promisify(execFile);
export const ghApi: GithubApi = {
  async get(path) {
    try {
      const { stdout } = await exec(
        "gh",
        ["api", "--hostname", "github.com", path],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: 30000,
          env: { ...process.env, GH_DEBUG: "" },
        },
      );
      return JSON.parse(stdout);
    } catch (error) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      throw new GithubApiError(/HTTP 404/.test(stderr) ? 404 : undefined);
    }
  },
};
const repoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  archived: z.boolean(),
  fork: z.boolean(),
});
const fileSchema = z.object({
  type: z.string(),
  path: z.string(),
  sha: z.string().optional(),
  size: z.number().optional(),
  html_url: z.string().nullable().optional(),
});
const prSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  merged_at: z.string().nullable(),
  html_url: z.string().optional(),
});
export interface GithubOptions {
  owner: string;
  repos?: string[];
  since?: string;
  includeArchived?: boolean;
  includeForks?: boolean;
}
export interface GithubStats {
  skipped: number;
  errors: number;
  repositories: number;
}

async function* pages(api: GithubApi, path: string): AsyncGenerator<unknown> {
  for (let page = 1; ; page++) {
    const result = z
      .array(z.unknown())
      .parse(
        await api.get(
          `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        ),
      );
    yield* result;
    if (result.length < 100) break;
  }
}
async function* repositories(
  options: GithubOptions,
  api: GithubApi,
  stats: GithubStats,
): AsyncGenerator<z.infer<typeof repoSchema>> {
  if (options.repos) {
    for (const name of new Set(options.repos)) {
      try {
        yield repoSchema.parse(
          await api.get(`/repos/${options.owner}/${name}`),
        );
      } catch {
        stats.errors++;
      }
    }
    return;
  }
  // Public owner repositories plus private repositories readable by this login.
  const seen = new Set<string>();
  for (const path of [`/users/${options.owner}/repos`, "/user/repos"]) {
    for await (const value of pages(api, path)) {
      const repo = repoSchema.parse(value);
      if (
        repo.full_name.split("/")[0]?.toLowerCase() !==
          options.owner.toLowerCase() ||
        seen.has(repo.full_name)
      )
        continue;
      seen.add(repo.full_name);
      yield repo;
    }
  }
}
async function directory(
  api: GithubApi,
  repo: string,
  path: string,
): Promise<z.infer<typeof fileSchema>[]> {
  try {
    const entries = z
      .array(fileSchema)
      .parse(await api.get(`/repos/${repo}/contents/${path}`));
    // The contents API silently caps directories at 1000 entries. Surface that limit.
    if (entries.length >= 1000) throw new GithubApiError();
    return entries;
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return [];
    throw error;
  }
}
export async function* collectGithub(
  options: GithubOptions,
  api: GithubApi = ghApi,
  stats: GithubStats = { skipped: 0, errors: 0, repositories: 0 },
): AsyncGenerator<ImportLine> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(options.owner) ||
    options.repos?.some((r) => !/^[A-Za-z0-9._-]+$/.test(r))
  )
    throw new Error("Invalid owner or repo");
  if (options.since) z.iso.datetime({ offset: true }).parse(options.since);
  for await (const repo of repositories(options, api, stats)) {
    if (
      (repo.archived && !options.includeArchived) ||
      (repo.fork && !options.includeForks)
    ) {
      stats.skipped++;
      continue;
    }
    stats.repositories++;
    const name = repo.full_name;
    try {
      for (const path of ["", "docs", "docs/adr"]) {
        for (const file of await directory(api, name, path)) {
          if (
            file.type !== "file" ||
            !(
              /\.(md|txt|rst)$/i.test(file.path) ||
              /(?:^|\/)README$/i.test(file.path)
            )
          )
            continue;
          if (
            !file.sha ||
            !/^[a-f0-9]+$/i.test(file.sha) ||
            file.size === undefined ||
            file.size > 256 * 1024
          ) {
            stats.skipped++;
            continue;
          }
          try {
            const blob = z
              .object({ encoding: z.literal("base64"), content: z.string() })
              .parse(await api.get(`/repos/${name}/git/blobs/${file.sha}`));
            const bytes = Buffer.from(blob.content, "base64");
            if (bytes.length > 256 * 1024) {
              stats.skipped++;
              continue;
            }
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes,
            );
            if (!text.trim()) {
              stats.skipped++;
              continue;
            }
            yield collectedItem({
              id: `github:${name}:file:${file.path}@${file.sha}`,
              text,
              title: file.path,
              area: "projects",
              kind: /(?:^|\/)README/i.test(file.path)
                ? "readme"
                : file.path.startsWith("docs/adr/")
                  ? "adr"
                  : "document",
              url:
                file.html_url ??
                `https://github.com/${name}/blob/HEAD/${file.path.split("/").map(encodeURIComponent).join("/")}`,
              metadata: { repo: name, path: file.path, blob_sha: file.sha },
            });
          } catch {
            stats.errors++;
          }
        }
      }
    } catch {
      stats.errors++;
    }
    try {
      for await (const value of pages(
        api,
        `/repos/${name}/pulls?state=closed&sort=updated&direction=desc`,
      )) {
        const pr = prSchema.parse(value);
        if (
          !pr.merged_at ||
          (options.since &&
            Date.parse(pr.merged_at) < Date.parse(options.since))
        )
          continue;
        try {
          yield collectedItem({
            id: `github:${name}:pr:${pr.number}`,
            text: `${pr.title}\n\n${pr.body ?? ""}`,
            title: pr.title,
            created_at: pr.merged_at,
            area: "projects",
            kind: "pr",
            url: pr.html_url ?? `https://github.com/${name}/pull/${pr.number}`,
            metadata: {
              repo: name,
              number: String(pr.number),
              merged_at: pr.merged_at,
            },
          });
        } catch {
          stats.errors++;
        }
      }
    } catch {
      stats.errors++;
    }
  }
}
