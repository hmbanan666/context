import assert from "node:assert/strict";
import { test } from "node:test";
import { createLlm } from "../src/llm.js";

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
