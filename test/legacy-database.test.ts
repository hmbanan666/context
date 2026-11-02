import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { backupDatabase, restoreDatabase } from "../src/backup.js";
import { readConfig } from "../src/config.js";
import { startService } from "../src/server.js";

const tables = [
  "sources",
  "source_metadata",
  "source_files",
  "capture_requests",
  "knowledge_items",
  "knowledge_relations",
  "knowledge_reviews",
  "knowledge_requests",
  "processing_jobs",
  "processing_requests",
  "work_authorizations",
  "work_observations",
];
function snapshot(path: string) {
  const db = new DatabaseSync(path);
  try {
    assert.equal(
      db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    return tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  } finally {
    db.close();
  }
}

test("pre-cleanup database keeps every domain row, original bytes, retry and legacy status through reopen and restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-legacy-"));
  const path = join(directory, "old.db");
  try {
    const db = new DatabaseSync(path);
    db.exec(
      await readFile(
        new URL("../../test/fixtures/pre-cleanup.sql", import.meta.url),
        "utf8",
      ),
    );
    db.close();
    const before = snapshot(path);
    const restored = join(directory, "restored.db");
    const scope = "private:personal";
    for (const database of [path, path, restored]) {
      const service = await startService(
        readConfig({
          NODE_ENV: "test",
          CONTEXT_PORT: "0",
          CONTEXT_DB_PATH: database,
          CONTEXT_LOCAL_MCP: "enabled",
          CONTEXT_AREAS: `${scope},synthetic:legacy`,
        }),
      );
      const client = new Client({ name: "legacy-reader", version: "1" });
      try {
        assert.equal(service.address.address, "127.0.0.1");
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${service.address.port}/mcp`),
          ),
        );
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const removed of [
          "knowledge_history",
          "project_context",
          "work_context",
        ])
          assert.ok(!names.includes(removed));
        const timeline = await client.callTool({
          name: "memory_context",
          arguments: { scope },
        });
        assert.ok(!timeline.isError);
        const data = timeline.structuredContent as {
          sources: { source: { id: string }; file?: unknown }[];
          totalMatchingSources: number;
        };
        assert.equal(data.totalMatchingSources, 2);
        const file = data.sources.find((m) => m.file);
        assert.ok(file);
        const bytes = await client.callTool({
          name: "read_file",
          arguments: { version: 1, scope, id: file.source.id },
        });
        assert.ok(!bytes.isError);
        assert.ok(
          JSON.stringify(bytes.structuredContent).includes(
            Buffer.from("\ufeffFictional garden file\r\n").toString("base64"),
          ),
        );
        const legacy = await client.callTool({
          name: "capture",
          arguments: {
            version: 1,
            scope: "synthetic:legacy",
            text: "Fictional old area source",
            origin: "fixture:legacy",
            idempotencyKey: "legacy-capture",
          },
        });
        assert.equal(
          z.object({ duplicate: z.boolean() }).parse(legacy.structuredContent)
            .duplicate,
          true,
        );
        const material = await client.callTool({
          name: "capture_material",
          arguments: {
            version: 1,
            scope,
            text: "Fictional garden notebook: preserve the violet lamp.",
            origin: "mcp:fictional-cli",
            idempotencyKey: "legacy-note",
            metadata: {
              title: "Fictional notebook",
              createdAt: "2026-10-01T12:00:00Z",
            },
          },
        });
        assert.equal(
          z.object({ duplicate: z.boolean() }).parse(material.structuredContent)
            .duplicate,
          true,
        );
        const knowledge = await client.callTool({
          name: "read_knowledge",
          arguments: { version: 1, scope },
        });
        assert.ok(!knowledge.isError);
        assert.ok(
          JSON.stringify(knowledge.structuredContent).includes(
            '"status":"rejected"',
          ),
        );
        const packageResult = await client.callTool({
          name: "context_package",
          arguments: { scope, question: "violet" },
        });
        assert.ok(!packageResult.isError);
        assert.ok(
          !JSON.stringify(packageResult.structuredContent).includes(
            '"status":"rejected"',
          ),
        );
        const denied = await client.callTool({
          name: "memory_context",
          arguments: { scope: "garden" },
        });
        assert.equal(
          z.object({ error: z.string() }).parse(denied.structuredContent).error,
          "forbidden_scope",
        );
      } finally {
        await client.close();
        await service.close();
      }
      assert.deepEqual(snapshot(database), before);
      if (
        database === path &&
        !(await import("node:fs")).existsSync(restored)
      ) {
        const backup = join(directory, "backup.db");
        await backupDatabase(path, backup);
        await restoreDatabase(backup, restored);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
