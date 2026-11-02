import type { ClientGrants } from "../../src/access.js";
import { AuthStore, secret } from "../../src/auth-store.js";
export function fixtureAuth(
  grants: ClientGrants,
  resource: string,
  path = ":memory:",
) {
  const areas = [
    ...new Set(
      Object.values(grants).flatMap((g) => [
        ...g.read,
        ...g.write,
        ...g.process,
      ]),
    ),
  ];
  const store = new AuthStore(path, areas);
  for (const [id, grant] of Object.entries(grants)) {
    if (!store.listClients().some((c) => c.id === id))
      store.saveClient({
        id,
        name: id,
        kind: "cli",
        redirects: [],
        grants: grant,
        defaultWrite: grant.write[0] ?? null,
        created: 0,
        lastUsed: null,
        revoked: false,
        refresh: false,
      });
  }
  return {
    store,
    config: {
      resource,
      issuer: new URL(resource).origin,
      areas,
      refreshSeconds: 86400,
      offlineSeconds: 30 * 86400,
    },
    token(clientId: string, scopes: string[], subject = "synthetic-owner") {
      const granted = grants[clientId];
      if (!granted || subject !== "synthetic-owner") return secret();
      const write = granted.write.filter(
        (a) => scopes.includes("context:write") && scopes.includes(a),
      );
      return store.createCliToken(
        clientId,
        {
          read: granted.read.filter(
            (a) => scopes.includes("context:read") && scopes.includes(a),
          ),
          write,
          process: granted.process.filter(
            (a) => scopes.includes("context:process") && scopes.includes(a),
          ),
        },
        write[0] ?? null,
        86400,
        resource,
      ).token;
    },
  };
}
