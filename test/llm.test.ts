import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlm, llmExtractor } from "../src/llm.js";

test("OpenAI-compatible client requires key and model, validates JSON and never follows redirects", async () => {
  assert.equal(createLlm({}), undefined);
  assert.equal(createLlm({ CONTEXT_LLM_MODEL: "fixture" }), undefined);
  assert.equal(createLlm({ CONTEXT_LLM_API_KEY: "fake" }), undefined);
  let calls = 0;
  const client = createLlm(
    {
      CONTEXT_LLM_API_KEY: "fake",
      CONTEXT_LLM_MODEL: "fixture",
      CONTEXT_LLM_BASE_URL: "http://localhost:1234/v1/",
    },
    async (url, init) => {
      calls++;
      assert.equal(String(url), "http://localhost:1234/v1/chat/completions");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fake",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "fixture");
      assert.ok(!JSON.stringify(body).includes(`sk-${"a".repeat(40)}`));
      return Response.json({
        choices: [
          {
            message: {
              content: calls === 1 ? '{"supersedes":true}' : "invalid",
            },
          },
        ],
      });
    },
  );
  assert.ok(client);
  assert.deepEqual(
    await client?.ask("Return JSON", { text: `token sk-${"a".repeat(40)}` }),
    { supersedes: true },
  );
  await assert.rejects(() => client.ask("Return JSON", {}));
});

test("Codex opt-in uses subscription-only isolated JSON inference and the shared extractor", async () => {
  const { fakeCodex } = await import("./fake-codex.js");
  const fake = await fakeCodex(`
assert.equal(args[0], '-a');
assert.equal(args[1], 'never');
assert.ok(args.includes('exec'));
for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag), flag);
assert.equal(args[args.indexOf('--sandbox')+1], 'read-only');
assert.equal(args[args.indexOf('--model')+1], 'gpt-6-luna');
for (const setting of ['model_reasoning_effort="low"', 'forced_login_method="chatgpt"', 'mcp_servers={}', 'web_search="disabled"']) assert.ok(args.includes(setting), setting);
for (const feature of ['shell_tool', 'apps', 'plugins', 'memories', 'hooks', 'multi_agent']) assert.ok(args.some((a,i) => a === '--disable' && args[i+1] === feature), feature);
assert.ok(process.cwd().startsWith('/tmp/context-codex-'));
assert.deepEqual(fs.readdirSync(process.cwd()), []);
assert.ok(process.env.CODEX_HOME.endsWith('/login'));
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.CONTEXT_LLM_API_KEY, undefined);
assert.equal(process.env.CODEX_API_KEY, undefined);
assert.ok(!prompt.includes('sk-' + 'a'.repeat(40)));
respond({items: []});
`);
  try {
    const client = createLlm({
      ...fake.env,
      OPENAI_API_KEY: "synthetic-api-key",
      CONTEXT_LLM_API_KEY: "synthetic-api-key",
      CODEX_API_KEY: "synthetic-api-key",
    });
    assert.ok(client);
    assert.equal(client.model, "gpt-6-luna");
    assert.deepEqual(
      await client.ask("Return JSON", { text: `token sk-${"a".repeat(40)}` }),
      { items: [] },
    );
    assert.deepEqual(
      await llmExtractor(client)({
        source: {
          id: "synthetic",
          text: "Synthetic note",
          origin: "fixture",
          scope: "personal",
          capturedAt: "2026-01-01T00:00:00Z",
          checksum: "synthetic",
          status: "unreviewed",
        },
        processorVersion: "fixture",
      }),
      { items: [] },
    );
  } finally {
    await fake.close();
  }
});
