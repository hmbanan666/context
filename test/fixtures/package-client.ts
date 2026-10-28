import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ClientGrants } from "../../src/access.js";
import { protectMcp } from "../../src/auth.js";
import { KnowledgeStore } from "../../src/knowledge.js";
import { createContextMcp } from "../../src/mcp.js";
import { SourceStore } from "../../src/store.js";

const scope = "private:personal";
const resource = "https://context.kosarev.space/mcp";
const issuer = "https://context.kosarev.space/auth/realms/context";
const grants: ClientGrants = {
  "context-chatgpt": { read: [scope], write: [scope], process: [] },
  "context-codex": { read: [scope], write: [], process: [] },
};
const key = await generateKeyPair("RS256");
const jwk = await exportJWK(key.publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] });

export async function openPackageFixture(path: string, personalMemory = true) {
  const store = new SourceStore(path);
  const knowledge = new KnowledgeStore(path);
  const mcp = createContextMcp(store, [], true, {
    knowledge,
    clientGrants: grants,
    personalMemory,
  });
  const handler = protectMcp(
    mcp,
    { resource, issuer, ownerSubject: "synthetic-owner", clientGrants: grants },
    keys,
  );
  const clients: Client[] = [];
  return {
    store,
    knowledge,
    handler,
    async connect(
      clientId = "context-chatgpt",
      scopes = ["context:read", "context:write", scope],
      subject = "synthetic-owner",
    ) {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        sub: subject,
        azp: clientId,
        scope: scopes.join(" "),
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience(resource)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(key.privateKey);
      const client = new Client({
        name: "personal-pilot-fixture",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => handler.fetch(new Request(input, init)),
        }),
      );
      return client;
    },
    async close() {
      for (const client of clients) await client.close();
      await mcp.close();
      knowledge.close();
      store.close();
    },
  };
}
