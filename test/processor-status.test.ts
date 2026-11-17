import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";
import { readConfig } from "../src/config.js";
import { processorOffLog, processorState } from "../src/llm.js";
import { startTestService as startService } from "./fixtures/search-service.js";

const model = "synthetic-model-name-not-for-logs";
const key = "synthetic-key-not-for-logs";

test("processor state is off or a kind and the startup line is not a failure", () => {
  assert.equal(processorState({}), "off");
  assert.equal(processorState({ CONTEXT_LLM_MODEL: model }), "off");
  assert.equal(processorState({ CONTEXT_LLM_API_KEY: key }), "off");
  assert.equal(
    processorState({ CONTEXT_LLM_API_KEY: key, CONTEXT_LLM_MODEL: model }),
    "openai",
  );
  assert.equal(processorState({ CONTEXT_PROCESSOR: "codex" }), "codex");
  assert.equal(
    processorState({ CONTEXT_PROCESSOR: "codex", CONTEXT_LLM_MODEL: model }),
    "codex",
  );
  assert.equal(
    processorState({
      CONTEXT_PROCESSOR: "nope",
      CONTEXT_LLM_API_KEY: key,
      CONTEXT_LLM_MODEL: model,
    }),
    "off",
  );
  assert.equal(readConfig({}).processor, "off");
  assert.equal(
    readConfig({
      CONTEXT_LLM_API_KEY: key,
      CONTEXT_LLM_MODEL: model,
    }).processor,
    "openai",
  );
  const notice = JSON.parse(processorOffLog()) as {
    event: string;
    processor: string;
    detail: string;
  };
  assert.equal(notice.event, "processor");
  assert.equal(notice.processor, "off");
  assert.match(notice.detail, /supported mode/);
  assert.equal(processorOffLog().includes("error"), false);
  assert.equal(processorOffLog().includes(model), false);
  assert.equal(processorOffLog().includes(key), false);
});

test("health reports the processor kind and nothing secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-health-processor-"));
  const databasePath = join(directory, "context.db");
  try {
    const off = await startService({
      port: 0,
      databasePath,
      processor: "off",
    });
    try {
      const offHealth = (await (
        await fetch(`http://127.0.0.1:${off.address.port}/health`)
      ).json()) as { status: string; processor: string; embeddings: string };
      assert.equal(offHealth.status, "ok");
      assert.equal(offHealth.processor, "off");
      assert.match(offHealth.embeddings, /^(off|warming|ready)$/);
    } finally {
      await off.close();
    }
    for (const processor of ["openai", "codex"] as const) {
      const service = await startService({ port: 0, databasePath, processor });
      try {
        const body = (await (
          await fetch(`http://127.0.0.1:${service.address.port}/health`)
        ).json()) as { status: string; processor: string; embeddings: string };
        assert.equal(body.status, "ok");
        assert.equal(body.processor, processor);
        assert.match(body.embeddings, /^(off|warming|ready)$/);
        assert.equal(JSON.stringify(body).includes(model), false);
        assert.equal(JSON.stringify(body).includes(key), false);
      } finally {
        await service.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup logs distillation off once and does not print a configured model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-processor-log-"));
  const databasePath = join(directory, "context.db");
  const main = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
  const children: ChildProcess[] = [];
  const start = (extra: NodeJS.ProcessEnv) =>
    new Promise<{ port: number; text: () => string }>((resolve, reject) => {
      const child = spawn(process.execPath, [main], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          CONTEXT_DB_PATH: databasePath,
          CONTEXT_PORT: "0",
          CONTEXT_AREAS: "studio",
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        reject(new Error(`startup timed out\n${stdout}\n${stderr}`));
      }, 8000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const line = stdout
          .split("\n")
          .find((item) => item.includes('"event":"listening"'));
        if (!line) return;
        clearTimeout(timer);
        resolve({
          port: Number(JSON.parse(line).port),
          text: () => `${stdout}\n${stderr}`,
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  };
  try {
    const off = await start({});
    for (let i = 0; i < 50 && !off.text().includes('"event":"processor"'); i++)
      await delay(20);
    const health = await (
      await fetch(`http://127.0.0.1:${off.port}/health`)
    ).json();
    const reported = health as {
      status: string;
      processor: string;
      embeddings: string;
    };
    assert.equal(reported.status, "ok");
    assert.equal(reported.processor, "off");
    assert.match(reported.embeddings, /^(off|warming|ready)$/);
    const notices = off
      .text()
      .split("\n")
      .filter((line) => line.includes('"event":"processor"'))
      .map((line) => JSON.parse(line) as { processor: string; detail: string });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.processor, "off");
    assert.match(notices[0]?.detail ?? "", /supported mode/);
    assert.equal(JSON.stringify(notices[0]).includes("error"), false);
    await stop(children[0]!);

    const configured = await start({
      CONTEXT_PROCESSOR: "openai",
      CONTEXT_LLM_MODEL: model,
      CONTEXT_LLM_API_KEY: key,
    });
    await delay(50);
    const open = await (
      await fetch(`http://127.0.0.1:${configured.port}/health`)
    ).json();
    const openBody = open as {
      status: string;
      processor: string;
      embeddings: string;
    };
    assert.equal(openBody.status, "ok");
    assert.equal(openBody.processor, "openai");
    assert.match(openBody.embeddings, /^(off|warming|ready)$/);
    assert.equal(configured.text().includes(model), false);
    assert.equal(configured.text().includes(key), false);
    assert.equal(configured.text().includes('"event":"processor"'), false);
    await stop(children[1]!);

    const codex = await start({ CONTEXT_PROCESSOR: "codex" });
    await delay(50);
    const codexHealth = await (
      await fetch(`http://127.0.0.1:${codex.port}/health`)
    ).json();
    const codexBody = codexHealth as {
      status: string;
      processor: string;
      embeddings: string;
    };
    assert.equal(codexBody.status, "ok");
    assert.equal(codexBody.processor, "codex");
    assert.match(codexBody.embeddings, /^(off|warming|ready)$/);
    assert.equal(codex.text().includes("gpt-6-luna"), false);
    assert.equal(codex.text().includes('"event":"processor"'), false);
    await stop(children[2]!);
  } finally {
    await Promise.all(children.map((child) => stop(child)));
    await rm(directory, { recursive: true, force: true });
  }
});
