import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { collectCodex } from "../src/collect-codex.js";

test("Codex collector keeps the first actual prompt and last final answer, excludes tools and reasoning, and reads task reports", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".output-collector-"));
  const sessions = join(dir, "sessions");
  const tasks = join(dir, "tasks");
  await mkdir(sessions);
  await mkdir(join(tasks, "fictional-task"), { recursive: true });
  const fake = `ghp_${"b".repeat(36)}`;
  const message = (role: string, text: string, phase?: string) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
  const lines = [
    {
      type: "session_meta",
      timestamp: "2026-01-02T12:00:00Z",
      payload: {
        id: "fictional-session",
        cwd: "/work/fictional",
        git: { repository_url: "https://example.org/fictional.git" },
      },
    },
    message(
      "user",
      "# AGENTS.md instructions for /work/fictional\nDO NOT IMPORT",
    ),
    message("user", `Initial telescope task ${fake}`),
    message("assistant", "DO NOT IMPORT commentary", "commentary"),
    {
      type: "response_item",
      payload: { type: "reasoning", summary: "DO NOT IMPORT reasoning" },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", output: "DO NOT IMPORT tool" },
    },
    message("assistant", "First final", "final_answer"),
    message("user", "DO NOT IMPORT later prompt"),
    message("assistant", "Final telescope report", "final_answer"),
  ];
  try {
    await writeFile(
      join(sessions, "rollout.jsonl"),
      lines.map((x) => JSON.stringify(x)).join("\n"),
    );
    await writeFile(join(tasks, "fictional-task", "prompt.txt"), "Task prompt");
    await writeFile(
      join(tasks, "fictional-task", "last.md"),
      `Task final password=fake-task-secret ${"x".repeat(12000)}`,
    );
    const items = [];
    for await (const item of collectCodex({ sessions, tasks }))
      items.push(item);
    assert.deepEqual(
      items.map((i) => i.id),
      ["codex:fictional-session", "codex-task:fictional-task"],
    );
    assert.ok(items[0]?.text.includes("Initial telescope task [REDACTED]"));
    assert.ok(items[0]?.text.includes("Final telescope report"));
    assert.ok(!JSON.stringify(items).includes("DO NOT IMPORT"));
    assert.ok(!JSON.stringify(items).includes(fake));
    assert.ok(!JSON.stringify(items).includes("fake-task-secret"));
    assert.equal(items[0]?.metadata?.cwd, "/work/fictional");
    assert.equal(items[0]?.metadata?.repo, "https://example.org/fictional.git");
    assert.equal(items[1]?.metadata?.truncated, "true");
    assert.ok((items[1]?.text.length ?? 0) <= 8192);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub collector includes bounded docs and merged PRs with stable IDs, filters repos and dates", async () => {
  const { collectGithub } = await import("../src/collect-github.js");
  const repo = {
    name: "observatory",
    full_name: "fictional/observatory",
    archived: false,
    fork: false,
  };
  const responses: Record<string, unknown> = {
    "/users/fictional/repos?per_page=100&page=1": [
      repo,
      {
        ...repo,
        name: "archive",
        full_name: "fictional/archive",
        archived: true,
      },
      { ...repo, name: "fork", full_name: "fictional/fork", fork: true },
    ],
    "/user/repos?per_page=100&page=1": [repo],
    "/repos/fictional/observatory/contents/": [
      { type: "file", path: "README.md", sha: "abc123", size: 100 },
      { type: "dir", path: "docs" },
      { type: "file", path: "package.json", size: 10 },
    ],
    "/repos/fictional/observatory/contents/docs": [
      { type: "dir", path: "docs/adr" },
      { type: "file", path: "docs/design.md", sha: "def456", size: 100 },
    ],
    "/repos/fictional/observatory/contents/docs/adr": [
      { type: "file", path: "docs/adr/0001.md", sha: "aaa111", size: 100 },
    ],
    "/repos/fictional/observatory/git/blobs/abc123": {
      encoding: "base64",
      content: Buffer.from("Readme telescope token=fictional-secret").toString(
        "base64",
      ),
    },
    "/repos/fictional/observatory/git/blobs/def456": {
      encoding: "base64",
      content: Buffer.from("Design telescope").toString("base64"),
    },
    "/repos/fictional/observatory/git/blobs/aaa111": {
      encoding: "base64",
      content: Buffer.from("Accepted telescope decision").toString("base64"),
    },
    "/repos/fictional/observatory/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1":
      [
        {
          number: 7,
          title: "Add telescope",
          body: "Merged report",
          merged_at: "2026-02-01T12:00:00Z",
          html_url: "https://github.com/fictional/observatory/pull/7",
        },
        { number: 8, title: "Unmerged", merged_at: null },
        { number: 2, title: "Old", merged_at: "2025-01-01T12:00:00Z" },
      ],
  };
  const items = [];
  const api = {
    async get(path: string): Promise<unknown> {
      assert.ok(path in responses, path);
      return responses[path];
    },
  };
  for await (const item of collectGithub(
    { owner: "fictional", since: "2026-01-01T00:00:00Z" },
    api,
  ))
    items.push(item);
  assert.deepEqual(
    items.map((x) => x.id),
    [
      "github:fictional/observatory:file:README.md@abc123",
      "github:fictional/observatory:file:docs/design.md@def456",
      "github:fictional/observatory:file:docs/adr/0001.md@aaa111",
      "github:fictional/observatory:pr:7",
    ],
  );
  assert.ok(!JSON.stringify(items).includes("fictional-secret"));
  assert.equal(items[3]?.created_at, "2026-02-01T12:00:00Z");
  assert.equal(items[3]?.metadata?.number, "7");
  assert.ok(items.every((x) => x.area === "projects"));
});

test("collectors output lines accepted by the importer; unfinished sessions and symlinks are skipped", async () => {
  const { symlink } = await import("node:fs/promises");
  const { importJsonl } = await import("../src/imports.js");
  const { SourceStore } = await import("../src/store.js");
  const dir = await mkdtemp(join(process.cwd(), ".output-collector-"));
  const store = new SourceStore(":memory:");
  const stats = { skipped: 0, errors: 0 };
  try {
    const events = [
      {
        type: "session_meta",
        payload: {
          id: "old-format",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/work/synthetic",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Build a telescope" }],
        },
      },
    ];
    await writeFile(
      join(dir, "unfinished.jsonl"),
      events.map((x) => JSON.stringify(x)).join("\n"),
    );
    await writeFile(
      join(dir, "complete.jsonl"),
      [
        ...events,
        {
          type: "event_msg",
          timestamp: "2026-01-01T01:00:00Z",
          payload: {
            type: "task_complete",
            last_agent_message: "Built a telescope",
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    await symlink(join(dir, "complete.jsonl"), join(dir, "link.jsonl"));
    const summary = await importJsonl(
      store,
      (async function* () {
        for await (const item of collectCodex({ sessions: dir }, stats))
          yield `${JSON.stringify(item)}\n`;
      })(),
      { source: "codex", areas: ["projects"] },
      () => {},
    );
    assert.equal(summary.created, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.errors, 0);
    assert.equal(store.search("telescope", "projects", 10).length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GitHub paginates merged PRs and continues after an unreadable selected repo", async () => {
  const { collectGithub, GithubApiError } = await import(
    "../src/collect-github.js"
  );
  const stats = { skipped: 0, errors: 0, repositories: 0 };
  const api = {
    async get(path: string): Promise<unknown> {
      if (path === "/repos/fictional/denied") throw new GithubApiError(404);
      if (path === "/repos/fictional/allowed")
        return {
          name: "allowed",
          full_name: "fictional/allowed",
          archived: true,
          fork: true,
        };
      if (path.includes("/contents/")) throw new GithubApiError(404);
      if (path.endsWith("page=1"))
        return Array.from({ length: 100 }, (_, n) => ({
          number: n + 1,
          title: `Synthetic change ${n}`,
          merged_at: "2026-01-01T00:00:00Z",
        }));
      if (path.endsWith("page=2"))
        return [
          {
            number: 101,
            title: "Last change",
            merged_at: "2026-01-02T00:00:00Z",
          },
        ];
      throw new Error("Unexpected synthetic request");
    },
  };
  const items = [];
  for await (const item of collectGithub(
    {
      owner: "fictional",
      repos: ["denied", "allowed"],
      includeArchived: true,
      includeForks: true,
    },
    api,
    stats,
  ))
    items.push(item);
  assert.equal(items.length, 101);
  assert.equal(items[100]?.id, "github:fictional/allowed:pr:101");
  assert.deepEqual(stats, { skipped: 0, errors: 1, repositories: 1 });
});
