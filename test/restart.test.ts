import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { syntheticSource } from "../fixtures/synthetic-source.js";
import { SourceStore } from "../src/store.js";

function childEnvironment(databasePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    CONTEXT_DB_PATH: databasePath,
    CONTEXT_PORT: "0",
    CONTEXT_LOCAL_MCP: "synthetic",
    CONTEXT_LOCAL_SCOPES: "synthetic:local-foundation",
  };
}

function run(entry: URL, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [fileURLToPath(entry)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0, `Shutdown failed with signal ${String(signal)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Service startup timed out"));
    }, 5000);
    const onExit = () => {
      cleanup();
      reject(new Error("Service exited before listening"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes("\n")) return;
      try {
        const event = JSON.parse(stdout.trim());
        assert.equal(event.event, "listening");
        assert.equal(event.address, "127.0.0.1");
        assert.equal(typeof event.port, "number");
        cleanup();
        resolve(event.port);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdout?.off("data", onData);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    child.stdout?.on("data", onData);
  });
}

test("synthetic source survives two real service processes and a repeated seed", {
  timeout: 20000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-restart-"));
  const databasePath = join(directory, "nested", "context.db");
  const env = childEnvironment(databasePath);
  let capturedSource: Record<string, unknown> | undefined;
  try {
    for (let restart = 0; restart < 2; restart++) {
      const seed = run(
        new URL("../scripts/seed-synthetic.js", import.meta.url),
        env,
      );
      const [seedCode] = await once(seed, "exit");
      assert.equal(seedCode, 0);
      const child = run(new URL("../src/main.js", import.meta.url), env);
      try {
        const port = await waitForPort(child);
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { status: "ok" });
        const client = new Client({
          name: "context-process-smoke",
          version: "1.0.0",
        });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${port}/mcp`),
            ),
          );
          const saved = await client.callTool({
            name: "capture",
            arguments: {
              version: 1,
              scope: syntheticSource.scope,
              text: syntheticSource.text,
              origin: "fixture:process-smoke",
              idempotencyKey: "process-smoke-001",
            },
          });
          assert.ok(!saved.isError);
          const output = z
            .record(z.string(), z.unknown())
            .parse(saved.structuredContent);
          const source = z.record(z.string(), z.unknown()).parse(output.source);
          assert.equal(output.duplicate, restart === 1);
          if (restart === 0) capturedSource = source;
          else assert.deepEqual(source, capturedSource);
          assert.equal(source.text, syntheticSource.text);
          assert.equal(
            source.checksum,
            "764a377a0b97c616c0d85f32c933f1be9c400b422a2581687778222efa45ae31",
          );
          const recalled = await client.callTool({
            name: "recall",
            arguments: {
              version: 1,
              scope: syntheticSource.scope,
              id: source.id,
            },
          });
          assert.deepEqual(
            z.record(z.string(), z.unknown()).parse(recalled.structuredContent)
              .sources,
            [capturedSource],
          );
          const seeded = await client.callTool({
            name: "recall",
            arguments: {
              version: 1,
              scope: syntheticSource.scope,
              query: "imaginary blue marbles",
            },
          });
          const matches = z
            .object({ sources: z.array(z.object({ id: z.string() })) })
            .parse(seeded.structuredContent);
          assert.deepEqual(
            matches.sources.map((match) => match.id).sort(),
            [syntheticSource.id, String(source.id)].sort(),
          );
        } finally {
          await client.close();
        }
      } finally {
        await stop(child);
      }
      const store = new SourceStore(databasePath);
      try {
        const record = store.find(syntheticSource.id, syntheticSource.scope);
        assert.ok(record);
        const { checksum, status, ...original } = record;
        assert.deepEqual(original, syntheticSource);
        assert.equal(
          checksum,
          "764a377a0b97c616c0d85f32c933f1be9c400b422a2581687778222efa45ae31",
        );
        assert.equal(status, "unreviewed");
      } finally {
        store.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production startup fails before opening a listener or database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-production-"));
  try {
    const child = run(new URL("../src/main.js", import.meta.url), {
      ...childEnvironment(join(directory, "context.db")),
      NODE_ENV: "production",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.equal(stdout, "");
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
