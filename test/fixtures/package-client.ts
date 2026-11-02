import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { ClientGrants } from "../../src/access.js";
import { protectMcp } from "../../src/auth.js";
import { KnowledgeStore } from "../../src/knowledge.js";
import { createContextMcp } from "../../src/mcp.js";
import { SourceStore } from "../../src/store.js";
import { fixtureAuth } from "./auth.js";

const scope = "personal";
const resource = "https://context.kosarev.space/mcp";
const grants: ClientGrants = {
  "context-chatgpt": { read: [scope], write: [scope], process: [] },
  "context-codex": { read: [scope], write: [], process: [] },
};

export async function openPackageFixture(path: string) {
  const store = new SourceStore(path);
  const auth = fixtureAuth(grants, resource, path);
  const knowledge = new KnowledgeStore(path);
  const mcp = createContextMcp(store, [], true, {
    knowledge,
    auth: auth.store,
  });
  const handler = protectMcp(mcp, auth.config, auth.store);
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
      const token = auth.token(clientId, scopes, subject);
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
      auth.store.close();
      store.close();
    },
  };
}
