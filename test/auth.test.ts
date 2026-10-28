import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import { z } from "zod";
import { authorizeScope, type ClientGrants } from "../src/access.js";
import {
  createTokenVerifier,
  type OAuthConfig,
  oauthScopes,
  protectMcp,
} from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { createContextMcp } from "../src/mcp.js";
import { startService } from "../src/server.js";
import { SourceStore } from "../src/store.js";

const config: OAuthConfig = {
  resource: "https://context.kosarev.space/mcp",
  issuer: "https://context.kosarev.space/auth/realms/context",
  ownerSubject: "synthetic-owner-subject",
};
const key = await generateKeyPair("RS256");
const publicJwk = await exportJWK(key.publicKey);
const keys = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: "synthetic-test-key" }],
});

async function token(overrides: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: config.issuer,
    aud: config.resource,
    sub: config.ownerSubject,
    azp: "context-codex",
    scope: oauthScopes.join(" "),
    iat: now,
    exp: now + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-test-key" })
    .sign(key.privateKey);
}

test("verifies signature, issuer, audience, owner, authorized client, expiry and token lifetime", async () => {
  const verifier = createTokenVerifier(config, keys);
  const accepted = await verifier.verifyAccessToken(await token());
  assert.deepEqual(accepted.scopes, oauthScopes);
  for (const changed of [
    { iss: "https://attacker.example" },
    { aud: "another-api" },
    { sub: "another-user" },
    { azp: "another-client" },
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 100 },
    { exp: Math.floor(Date.now() / 1000) + 3600 },
  ])
    await assert.rejects(() =>
      token(changed).then((value) => verifier.verifyAccessToken(value)),
    );
  await assert.rejects(() => verifier.verifyAccessToken("not-a-jwt"));
  const otherKey = await generateKeyPair("RS256");
  const forged = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-test-key" })
    .sign(otherKey.privateKey);
  await assert.rejects(() => verifier.verifyAccessToken(forged));
});

test("signed project scopes still require independent client and operation grants", async () => {
  const grants: ClientGrants = {
    "context-chatgpt": {
      read: ["synthetic:project:a", "synthetic:project:b"],
      write: ["synthetic:project:a", "synthetic:project:b"],
      process: ["synthetic:project:b"],
    },
    "context-codex": { read: ["synthetic:project:a"], write: [], process: [] },
  };
  const verifier = createTokenVerifier(
    { ...config, clientGrants: grants },
    keys,
  );
  const scope =
    "context:read context:write context:process synthetic:project:a synthetic:project:b synthetic:unconfigured unrelated:scope";
  const codex = await verifier.verifyAccessToken(await token({ scope }));
  assert.deepEqual(codex.scopes, [
    "context:read",
    "context:write",
    "context:process",
    "synthetic:project:a",
    "synthetic:project:b",
  ]);
  assert.equal(
    authorizeScope(
      codex.clientId,
      codex.scopes,
      "synthetic:project:a",
      "context:read",
      grants,
    ),
    true,
  );
  assert.equal(
    authorizeScope(
      codex.clientId,
      codex.scopes,
      "synthetic:project:b",
      "context:read",
      grants,
    ),
    false,
  );
  assert.equal(
    authorizeScope(
      codex.clientId,
      codex.scopes,
      "synthetic:project:a",
      "context:write",
      grants,
    ),
    false,
  );
  assert.equal(
    authorizeScope(
      codex.clientId,
      codex.scopes,
      "synthetic:project:a",
      "context:process",
      grants,
    ),
    false,
  );
  const chatgpt = await verifier.verifyAccessToken(
    await token({ scope, azp: "context-chatgpt" }),
  );
  assert.equal(
    authorizeScope(
      chatgpt.clientId,
      chatgpt.scopes,
      "synthetic:project:b",
      "context:process",
      grants,
    ),
    true,
  );
  const missing = await verifier.verifyAccessToken(
    await token({ scope: "context:read" }),
  );
  assert.equal(
    authorizeScope(
      missing.clientId,
      missing.scopes,
      "synthetic:project:a",
      "context:read",
      grants,
    ),
    false,
  );
  const missingClient = { "context-chatgpt": grants["context-chatgpt"] };
  assert.equal(
    authorizeScope(
      codex.clientId,
      codex.scopes,
      "synthetic:project:a",
      "context:read",
      missingClient,
    ),
    false,
  );
  await assert.rejects(() =>
    token({ scope, azp: "context-project-a" }).then((value) =>
      verifier.verifyAccessToken(value),
    ),
  );
});

test("protected MCP permits signed scoped requests and denies writes, cross-scope reads and missing tokens", async () => {
  const store = new SourceStore(":memory:");
  const mcp = createContextMcp(store, [], true);
  const handler = protectMcp(mcp, config, keys);
  const clients: Client[] = [];
  const connect = async (accessToken: string) => {
    const client = new Client({
      name: "synthetic-oauth-client",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.resource), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return client;
  };
  try {
    const anonymous = await handler.fetch(
      new Request(config.resource, { method: "POST" }),
    );
    assert.equal(anonymous.status, 401);
    assert.match(
      anonymous.headers.get("www-authenticate") ?? "",
      /resource_metadata=.*oauth-protected-resource/,
    );
    const writer = await connect(
      await token({
        scope:
          "context:read context:write synthetic:hosted-pilot offline_access",
      }),
    );
    const args = {
      version: 1,
      text: "Synthetic protected yellow kite",
      origin: "fixture:oauth",
      scope: "synthetic:hosted-pilot",
      idempotencyKey: "protected-001",
    };
    const saved = await writer.callTool({ name: "capture", arguments: args });
    assert.ok(!saved.isError);
    const output = z
      .object({ source: z.object({ id: z.string(), text: z.string() }) })
      .parse(saved.structuredContent);
    const reader = await connect(
      await token({ scope: "context:read synthetic:hosted-pilot" }),
    );
    const recalled = await reader.callTool({
      name: "recall",
      arguments: { version: 1, scope: args.scope, id: output.source.id },
    });
    assert.ok(!recalled.isError);
    const deniedWrite = await reader.callTool({
      name: "capture",
      arguments: args,
    });
    assert.equal(deniedWrite.isError, true);
    const deniedScope = await reader.callTool({
      name: "recall",
      arguments: { version: 1, scope: "synthetic:other", query: "kite" },
    });
    assert.equal(deniedScope.isError, true);
    for (const scope of [
      "offline_access",
      "context:read context:write offline_access",
      "synthetic:hosted-pilot offline_access",
    ]) {
      const unprivileged = await connect(await token({ scope }));
      for (const request of [
        {
          name: "recall",
          arguments: { version: 1, scope: args.scope, id: output.source.id },
        },
        { name: "capture", arguments: args },
      ]) {
        assert.equal((await unprivileged.callTool(request)).isError, true);
      }
    }
  } finally {
    for (const client of clients) await client.close();
    await mcp.close();
    store.close();
  }
});

for (const scenario of [
  {
    name: "pilot",
    grants: undefined,
    scopes: [
      "context:read",
      "context:write",
      "synthetic:hosted-pilot",
      "offline_access",
    ],
  },
  {
    name: "configured projects",
    grants: {
      "context-chatgpt": {
        read: ["synthetic:project:a"],
        write: ["synthetic:project:a"],
        process: [],
      },
      "context-codex": {
        read: ["synthetic:project:b"],
        write: [],
        process: [],
      },
    },
    scopes: [
      "context:read",
      "context:write",
      "context:process",
      "synthetic:project:a",
      "synthetic:project:b",
      "offline_access",
    ],
  },
]) {
  test(`production exposes OAuth metadata with refresh consent (${scenario.name}) and rejects missing authentication`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-protected-"));
    const production = readConfig({
      NODE_ENV: "production",
      CONTEXT_AUTH: "oauth",
      CONTEXT_PUBLIC_URL: config.resource,
      CONTEXT_OAUTH_ISSUER: config.issuer,
      CONTEXT_OWNER_SUBJECT: config.ownerSubject,
      CONTEXT_PORT: "0",
      CONTEXT_DB_PATH: join(directory, "context.db"),
      ...(scenario.grants === undefined
        ? {}
        : { CONTEXT_CLIENT_GRANTS: JSON.stringify(scenario.grants) }),
    });
    const service = await startService(production);
    try {
      const url = `http://127.0.0.1:${service.address.port}`;
      // Node fetch normalizes Host; use a raw HTTP client for host-specific tests elsewhere.
      const { request } = await import("node:http");
      const get = (path: string, method = "GET") =>
        new Promise<{
          status: number;
          headers: import("node:http").IncomingHttpHeaders;
          text: string;
        }>((resolve, reject) => {
          const outgoing = request(
            `${url}${path}`,
            { method, headers: { Host: "context.kosarev.space" } },
            (incoming) => {
              let text = "";
              incoming.setEncoding("utf8");
              incoming.on("data", (chunk) => {
                text += chunk;
              });
              incoming.on("end", () =>
                resolve({
                  status: incoming.statusCode ?? 0,
                  headers: incoming.headers,
                  text,
                }),
              );
            },
          );
          outgoing.on("error", reject);
          outgoing.end();
        });
      for (const path of [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource",
      ]) {
        const metadata = await get(path);
        assert.equal(metadata.status, 200);
        assert.deepEqual(JSON.parse(metadata.text), {
          resource: config.resource,
          authorization_servers: [config.issuer],
          scopes_supported: scenario.scopes,
          bearer_methods_supported: ["header"],
          resource_name: "Context synthetic pilot",
        });
      }
      const denied = await get("/mcp", "POST");
      assert.equal(denied.status, 401);
      assert.match(
        String(denied.headers["www-authenticate"]),
        /oauth-protected-resource/,
      );
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("limits authenticated client request rate with a retry hint", async () => {
  const handler = protectMcp(
    { fetch: async () => new Response(null, { status: 200 }) },
    config,
    keys,
  );
  const accessToken = await token();
  for (let count = 0; count < 60; count++) {
    assert.equal(
      (
        await handler.fetch(
          new Request(config.resource, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
        )
      ).status,
      200,
    );
  }
  const limited = await handler.fetch(
    new Request(config.resource, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});
