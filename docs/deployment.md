# Protected deployment preparation

**Status:** Sprint 2 implementation prepared; no hosted deployment or real
ChatGPT/Codex linking has been performed. The owner approved
`context.kosarev.space` as the Context service domain. Merge and live deployment
still require separate owner approval under AGENTS.md.

## Provider and addresses

Use self-hosted **Keycloak 26.8.1**, backed by a dedicated PostgreSQL 17.11
database. This avoids a new hosted identity account and keeps authentication
in an established provider. The `resource-indicators` feature is explicitly
enabled; Keycloak currently labels it experimental. This is a pilot limitation,
not a claim of verified hosted compatibility. See the
[Keycloak MCP guide](https://www.keycloak.org/securing-apps/mcp-authz-server).

| Purpose | Address |
| --- | --- |
| MCP resource / token audience | `https://context.kosarev.space/mcp` |
| Resource metadata | `https://context.kosarev.space/.well-known/oauth-protected-resource/mcp` |
| OAuth issuer | `https://context.kosarev.space/auth/realms/context` |
| Provider discovery | issuer + `/.well-known/openid-configuration` |
| Signing keys | issuer + `/protocol/openid-connect/certs` |
| Health | `https://context.kosarev.space/health` |

Keycloak handles login, authorization-code/PKCE S256, token issuance, refresh
and provider sessions. Context is only the resource server. It verifies RS256
signatures through the configured issuer's JWKS, exact issuer/audience, expiry,
`nbf`, a maximum five-minute token age/lifetime, the configured owner `sub`, and
the allowed `azp` client IDs (`context-chatgpt`, `context-codex`). No token URL or
key URL supplied by a caller is trusted. Verification failures return 401 and
an OAuth metadata challenge. Missing operation scopes return a tool error with
an OAuth scope challenge.

JWT validation is offline after key retrieval: session/refresh revocation does
**not** immediately revoke an already issued access token. Its maximum remaining
life is five minutes. For urgent suspension stop Context or change its owner
allowlist and restart it. JWKS retrieval failures deny access; no anonymous
fallback exists.

The only data scope is `synthetic:hosted-pilot`. Tokens must also grant
`context:read` for recall and `context:write` for capture. Subject validation
restricts this single-owner pilot even if another realm user requests the same
scopes. Real private-memory ingestion remains unapproved.

## Reproducible local evidence

```sh
npm ci
npm run check
npm run test:oauth-provider
docker build -t context:ci .
npm run test:container
```

The ordinary suite checks signed JWT rejection/acceptance, protected MCP,
scope boundaries, rate limits, strict configuration, persistence and SQLite
backup/restore. The container smoke uses disposable volumes to check health,
metadata/401, an internal synthetic seed, persistence across a container restart
and an offline restore under a non-root, read-only runtime. It does not claim
authenticated public HTTP interoperability. Both Docker smoke scripts require
Python 3 and Docker. The provider smoke
it starts a disposable Keycloak dev-mode container on a random loopback port,
imports a synthetic user into a temporary realm, performs actual browser-form
login/code exchange with PKCE, rejects a wrong verifier, checks the resource
audience, rotates refresh tokens and rejects replay, then verifies a real
Keycloak token/JWKS through Context capture/recall. It removes its container and
temporary realm afterward. Its public fixture password is local-test data only;
the production realm export contains no users or credentials.

That test uses Keycloak's development database. It does not prove production
PostgreSQL, TLS/proxy routing, ChatGPT's OAuth UI or a deployed roundtrip.

## Dokploy configuration

Create a **new Context-only Docker Compose application**, using
`deploy/compose.yaml` from the approved commit. Do not reuse another project's
database, network, application or storage. Do not expose the Docker socket.
Only one Context replica/writer is supported.

The compose file builds a non-root Node runtime, makes its root filesystem read
only and stores SQLite on its own volume. Keycloak and PostgreSQL have their own
database volume and private backend network. No host ports are published.
Keycloak's `/auth` router takes priority over the Context router. TLS, HTTP
redirect, HSTS and a proxy request-rate limit are configured with Traefik labels,
following [Dokploy's Compose routing](https://docs.dokploy.com/docs/core/docker-compose/example).

Enable Dokploy's isolated-deployment networking, or provision a dedicated
Context proxy network attached only to Context, its Keycloak and Traefik.
`CONTEXT_PROXY_NETWORK` must name that dedicated network, **not** the shared
`dokploy-network`. Set `CONTEXT_PROXY_CIDRS` to the actual trusted proxy
addresses/CIDRs on that network; do not guess or use an unrestricted range.
Keycloak accepts forwarded headers only from those peers. Its management health
port is never routed publicly. Verify both health checks after deployment.

Configure private environment values through Dokploy:

| Variable | Value / source |
| --- | --- |
| `CONTEXT_OWNER_SUBJECT` | Actual dedicated owner's Keycloak user UUID |
| `CONTEXT_IDENTITY_DB_PASSWORD` | New private password for this identity DB |
| `CONTEXT_IDENTITY_ADMIN_PASSWORD` | One-time private bootstrap password; required only by `deploy/bootstrap.yaml` |
| `CONTEXT_PROXY_NETWORK` | Verified isolated Context proxy network name |
| `CONTEXT_PROXY_CIDRS` | Verified proxy peer addresses/CIDRs |

Passwords are deliberately absent from the repository. Empty required settings
make Compose validation fail. Never paste them into a PR, shell history or chat.
Container logs must not be exported publicly. The resource process logs no
source records, tokens or exception contents. Application requests are limited
to 60 per client per minute; proxy limiting also protects unauthenticated paths.

## Identity bootstrap and client linking

1. For the first startup, add the bootstrap override and start only
   `identity-db` and `identity` to provision the realm. The base Compose file
   never requires or injects a bootstrap administrator credential. For Compose
   parsing during this identity-only bootstrap, the non-secret owner field may
   temporarily be `bootstrap-unused`; do not start Context with that value:

   ```sh
   CONTEXT_OWNER_SUBJECT=bootstrap-unused docker compose \
     -f deploy/compose.yaml -f deploy/bootstrap.yaml up -d identity-db identity
   ```
2. Sign into the new Keycloak admin console using its bootstrap credential,
   create one real owner account, require a strong password and configure MFA.
   Copy its user UUID into `CONTEXT_OWNER_SUBJECT`; keep personal profile fields
   and credentials out of Git. Use a permanent administrator, then remove the
   bootstrap administrator and its environment credential. Remove the bootstrap
   override from subsequent deployments and use `deploy/compose.yaml` alone;
   that configuration continues to validate without the temporary password.
3. The imported clients are deliberately **disabled**. For ChatGPT,
   copy the exact callback from its MCP management screen into `context-chatgpt`.
   The shipped stable URI is a candidate to verify, not permission to add
   wildcard callbacks. Enable the client only after checking that URI.
4. For Codex, use predefined client ID `context-codex`, fixed OAuth callback
   port 8765 and exact loopback callback `http://127.0.0.1:8765/callback`.
   Confirm the actual callback used by the installed client and adjust the
   single exact URI if necessary before enabling. No wildcard is shipped.
5. Start Context with its real owner subject. In ChatGPT choose OAuth and the
   predefined confidential client ID `context-chatgpt`, using
   `client_secret_basic`. Retrieve its generated secret privately from Keycloak
   and enter it only in ChatGPT's protected OAuth configuration; request
   `context:read context:write synthetic:hosted-pilot`. Configure Codex with
   the resource URL, its predefined client ID and the same scopes. Both clients
   must authenticate as the configured owner.
6. Prove discovery and the authorization-code/PKCE flow in the actual clients.
   Do not enable unrestricted registration to get past a client-linking error.

The configuration uses pre-registration rather than CIMD/DCR. OpenAI supports
predefined clients and requires PKCE, resource metadata and token verification;
its guide also explains how to copy the active callback:
[OpenAI authentication](https://developers.openai.com/plugins/build/auth).
Keycloak 26.8.1 does not advertise `none` in its discovery authentication-method
list. Therefore the ChatGPT client uses the advertised `client_secret_basic`
method. The predefined public Codex client successfully exchanges codes without
a secret in the local provider test; compatibility with the actual Codex OAuth
login must still be demonstrated. Do not claim metadata parity or live-client
compatibility from the provider test alone.
Provider discovery, `resource` binding and refresh behavior must still be
checked through the deployed proxy. If linking is incompatible, keep the pilot
synthetic and record the exact failure.

## Backup and restore

Keep backups private and copy them off the server to owner-controlled storage;
the included backup volume alone is not disaster recovery. For a live SQLite
snapshot after the build:

```sh
npm run database -- backup ./data/context.db ./backups/context-snapshot.db
```

Inside the Context container the equivalent is:

```sh
node dist/scripts/database.js backup /app/data/context.db /app/backups/context-snapshot.db
```

Both commands use SQLite's online backup API (including committed source WAL
pages), check integrity, refuse to
overwrite a snapshot and preserve sources, request keys and FTS. Use a new
backup filename for each run. To restore, **stop Context first**, restore into
a fresh destination without `-wal`/`-shm` sidecars, then set the database path
to that destination and restart:

```sh
npm run database -- restore ./backups/context-snapshot.db ./data/restored.db
```

Never restore over a live database or copy a live SQLite file without its WAL.
Restore has no force flag. Validate record IDs, checksums, scope and retry
behavior after restart. The automated test does this with synthetic sources.

Also take a private PostgreSQL `pg_dump -Fc` of `context_identity` using the
dedicated identity-db container. Restore it into an empty dedicated database
with Keycloak stopped, using `pg_restore --exit-on-error`; retain the exact
Keycloak/PostgreSQL versions until that restore has been verified. A realm
JSON import is bootstrap configuration, **not** an identity database backup.
It skips existing realms and does not automatically apply later config edits.

## Remaining hosted acceptance

- Owner approval of the concrete implementation and the live deployment.
- Dokploy connection, isolated network and TLS routing verified on the host.
- Both actual clients complete OAuth; wrong/missing/expired tokens and wrong
  scopes are rejected through the public endpoint.
- An actual ChatGPT `capture` writes one synthetic record; a fresh Codex session
  `recall`s its exact stable ID and checksum. Tool discovery alone is not proof.
- Redeploy/restart and an offline restore preserve that record.
- Record the deployed commit and evidence separately from PR/CI/merge state.

No claim in this document authorizes real private-memory ingestion or access
to other Dokploy applications.
