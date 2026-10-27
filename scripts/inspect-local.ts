import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { startService } from "../src/server.js";

const execute = promisify(execFile);
const object = z.record(z.string(), z.unknown());
const scope = "synthetic:inspector";
const capture = {
  version: 1,
  scope,
  text: "Synthetic inspector orange kites.",
  origin: "fixture:inspector",
  idempotencyKey: "inspector-001",
};

async function smoke() {
  const directory = await mkdtemp(join(tmpdir(), "context-inspector-"));
  const clientConfig = join(directory, "client.json");
  try {
    await writeFile(clientConfig, "{}");
    const config = {
      port: 0,
      databasePath: join(directory, "context.db"),
      localMcpScopes: [scope],
    };
    const inspect = async (
      port: number,
      method: string,
      era = "modern",
      tool?: string,
      args?: Record<string, unknown>,
    ) => {
      const command = [
        "--yes",
        "@modelcontextprotocol/inspector@2.12.0",
        "--cli",
        "--server-url",
        `http://127.0.0.1:${port}/mcp`,
        "--transport",
        "http",
        "--protocol-era",
        era,
        "--format",
        "json",
        "--quiet",
        "--stored-auth-only",
        "--client-config",
        clientConfig,
        "--method",
        method,
      ];
      if (tool && args)
        command.push(
          "--tool-name",
          tool,
          "--tool-args-json",
          JSON.stringify(args),
        );
      const { stdout } = await execute("npx", command, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      const output = object.parse(JSON.parse(stdout));
      return object.parse(output.result);
    };
    let source: Record<string, unknown> = {};
    let service = await startService(config);
    try {
      for (const era of ["modern", "legacy"]) {
        const listed = await inspect(service.address.port, "tools/list", era);
        const tools = z
          .array(z.object({ name: z.string() }))
          .parse(listed.tools);
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
          "capture",
          "recall",
        ]);
        console.log(`Inspector ${era}: tools/list passed`);
      }
      const saved = await inspect(
        service.address.port,
        "tools/call",
        "legacy",
        "capture",
        capture,
      );
      assert.ok(!saved.isError);
      source = object.parse(object.parse(saved.structuredContent).source);
      const duplicate = await inspect(
        service.address.port,
        "tools/call",
        "modern",
        "capture",
        capture,
      );
      const output = object.parse(duplicate.structuredContent);
      assert.equal(output.duplicate, true);
      assert.deepEqual(output.source, source);
      console.log("Inspector capture and duplicate retry: passed");
    } finally {
      await service.close();
    }
    service = await startService(config);
    try {
      for (const lookup of [{ id: source.id }, { query: "orange kites" }]) {
        const recalled = await inspect(
          service.address.port,
          "tools/call",
          "modern",
          "recall",
          { version: 1, scope, ...lookup },
        );
        assert.deepEqual(object.parse(recalled.structuredContent).sources, [
          source,
        ]);
      }
      console.log("Inspector new client recall and FTS after restart: passed");
    } finally {
      await service.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await smoke();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
