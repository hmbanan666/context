import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { protectMcp } from "../src/auth.js";
import { createContextMcp } from "../src/mcp.js";
import { SourceStore } from "../src/store.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { issuer, accessToken } = z
  .object({ issuer: z.url(), accessToken: z.string() })
  .parse(JSON.parse(input));
const resource = "https://context.kosarev.space/mcp";
const store = new SourceStore(":memory:");
const mcp = createContextMcp(store, [], true);
const protectedMcp = protectMcp(mcp, {
  issuer,
  resource,
  ownerSubject: "00000000-0000-4000-8000-000000000001",
});
const client = new Client({
  name: "synthetic-keycloak-proof",
  version: "1.0.0",
});
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      fetch: async (request, init) =>
        protectedMcp.fetch(new Request(request, init)),
    }),
  );
  const captured = await client.callTool({
    name: "capture",
    arguments: {
      version: 1,
      scope: "synthetic:hosted-pilot",
      text: "Synthetic Keycloak green kite",
      origin: "fixture:real-keycloak",
      idempotencyKey: "keycloak-001",
    },
  });
  assert.ok(!captured.isError);
  const { source } = z
    .object({ source: z.record(z.string(), z.unknown()) })
    .parse(captured.structuredContent);
  const recalled = await client.callTool({
    name: "recall",
    arguments: { version: 1, scope: "synthetic:hosted-pilot", id: source.id },
  });
  assert.deepEqual(
    z
      .object({ sources: z.array(z.unknown()) })
      .parse(recalled.structuredContent).sources,
    [source],
  );
  console.log(
    "Real Keycloak JWKS verification and protected MCP capture/recall: passed",
  );
} finally {
  await client.close();
  await mcp.close();
  store.close();
}
