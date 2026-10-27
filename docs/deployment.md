# Protected synthetic deployment

**Status:** PR #4 merged and the protected synthetic pilot deployed on
27 October 2026 after separate owner approval. Hosted TLS/OAuth and actual
Codex CLI login passed. The owner confirmed an actual ChatGPT capture-to-Codex
roundtrip, and a connected Codex tool independently recalled the same synthetic
record. Its separately approved live container recreation and offline restore
passed on 27 October 2026; Sprint 2 synthetic acceptance is closed. Further merges or live
changes still require their applicable owner approval under AGENTS.md.

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
starts a disposable Keycloak dev-mode container on a random loopback port,
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

Enable Dokploy's isolated-deployment networking and apply `deploy/dokploy.yaml`
**after** the converted base file. Dokploy 0.29.13 adds its proxy network to every
service, including PostgreSQL; the override uses Compose `!override` to keep the
database exclusively on its internal network and avoid duplicate references to
the proxy network. This requires Docker Compose 2.24.4 or newer; the host used
5.3.1. Before starting services, create the isolated network through a Context-only
preflight deployment with custom command `compose version`; Dokploy creates the
network and attaches Traefik even though no service starts. Inspect Traefik's
address on that network, then configure the values below.

The normal Dokploy custom command is a Docker subcommand (Dokploy prefixes
`docker`):

```sh
compose -p <context-app-name> --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/dokploy.yaml up -d --build --remove-orphans
```

Dokploy must create `deploy/.env`. When supplying values, verify the resulting
container values privately: Dokploy 0.29.13 parses the input environment before
writing `.env`, and Compose performs another interpolation pass. Do not assume
that quoting or dollar signs survive both passes unchanged. Never print the
values during verification.

Alternatively provision and maintain a dedicated Context proxy network attached
only to Context, its Keycloak and Traefik, with isolated conversion disabled.
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

   In Dokploy use the same `--env-file`, project name and final
   `-f deploy/dokploy.yaml` override as the normal command above; include
   `-f deploy/bootstrap.yaml` before that final override.
2. Sign into the new Keycloak admin console using its bootstrap credential,
   create one real owner account, require a strong password and configure MFA.
   Copy its user UUID into `CONTEXT_OWNER_SUBJECT`; keep personal profile fields
   and credentials out of Git. Use a permanent administrator, then remove the
   bootstrap administrator and its environment credential. Remove the bootstrap
   override from subsequent deployments; retain the Dokploy network override when
   using isolated deployment. The base `deploy/compose.yaml` configuration
   continues to validate without the temporary password.
   An email is optional in the Context realm; no placeholder address was added.
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
method. The predefined public Codex client completed actual Codex CLI 0.164.0
OAuth login through the deployed provider without a secret. Configure:

```toml
[mcp_servers.context]
url = "https://context.kosarev.space/mcp"
scopes = ["context:read", "context:write", "synthetic:hosted-pilot"]

[mcp_servers.context.oauth]
client_id = "context-codex"
callback_url = "http://127.0.0.1:8765/callback"
callback_port = 8765
```

Then run `codex mcp login context`. Do not add `oauth_resource` for this tested
CLI version: it already derives the resource from discovery, and setting both
produced duplicate `resource` parameters rejected by Keycloak. The exact
callback above was verified from the actual CLI authorization request, and only
then was `context-codex` enabled. The saved local configuration is available to
new Codex sessions; OAuth login alone does not prove a model tool invocation.

The ChatGPT client is enabled with the exact stable callback after verifying
issuer-bound success/error responses and the callback shown in ChatGPT's form.
In **Add custom MCP server → Advanced OAuth settings**, select **Custom OAuth
client**, enter `context-chatgpt`, privately supply its provider-generated secret, and select
`client_secret_basic`. Keep the three advertised scopes checked and turn off
**OIDC enabled**: this pilot does not provide `profile` or `email` scopes.

The UI initially chose DCR because Keycloak advertises a registration endpoint,
but anonymous registration is deliberately blocked (observed HTTP 403,
`insufficient_scope`). Do not enable open registration to resolve that form
error. Both predefined clients are now enabled; this is configuration evidence,
not proof of a completed ChatGPT link.

Owner refresh sessions used for setup were revoked before first-login MFA.
The owner then completed authenticator setup in their own browser. Provider
inspection confirmed an OTP credential, no pending `CONFIGURE_TOTP` action and
an active `context-chatgpt` session. The ChatGPT UI returned to the installed
Context page. At that setup checkpoint, actual ChatGPT tool execution still
needed separate evidence; the later owner-confirmed roundtrip and live recovery
verification are recorded below.
Run the Codex login again for a new authorized session; the setup credentials
were removed locally. Do not infer tool compatibility from provider sessions.

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

## Observed hosted evidence — 27 October 2026

The initial deployed source was the PR #4 merge commit
[`65ccd0b`](https://github.com/hmbanan666/context/commit/65ccd0bd5a0a017b16f84f1c0be980d307424688).
The Context image observed after redeploy is
`sha256:6ab5fc45dda8d3bc5f9a0255e08f3eb30cf3c96d85ace7437b960199e0391719`.
The network override in this change was applied as a Context-only Dokploy file
patch during the approved deployment. Merge of this follow-up is separate from
that live configuration; remove the redundant file patch only after it is in
the deployed branch. Automatic deployment is disabled.

- [Health](https://context.kosarev.space/health): HTTPS 200;
  [resource metadata](https://context.kosarev.space/.well-known/oauth-protected-resource/mcp):
  200 with the exact resource and issuer. Provider discovery returned the same
  issuer and S256 support through a valid public TLS certificate.
- Missing, malformed, genuinely expired provider tokens and a valid provider
  token with the wrong audience were rejected with 401. A read-only token's
  capture call returned a scope challenge without writing. Wrong PKCE was
  rejected; refresh tokens rotated and replay was rejected.
- Owner-completed MFA and a ChatGPT provider session were independently
  observed after the user returned to the installed plugin page.
- Actual installed Codex CLI 0.164.0 completed pre-registered OAuth login.
  Independent official SDK sessions discovered both tools, captured one
  synthetic fixture, and recalled its exact source after a process stop/start
  and full redeploy. The persistent idempotency key returned the original
  record; ID, timestamp, checksum, provenance and status were unchanged.
- A live SQLite snapshot was restored to an absent, separate file while
  Context was stopped. Exact source equality, FTS and idempotency passed against
  the restored file. The original database was retained and Context restarted;
  the live database was not replaced by the restored copy.
- With Keycloak stopped, `pg_dump -Fc` of its dedicated database was restored
  using `pg_restore --exit-on-error` into a new temporary database. The Context
  realm and owner existed in the restored database; that temporary database was
  removed and Keycloak restarted.
- Container inspection verified that PostgreSQL has only its internal network,
  Context has only the dedicated proxy network, and Keycloak has both. No host
  ports are published. The bootstrap administrator was deleted; the deployed
  Keycloak environment no longer contains its bootstrap credential.

The test scripts and raw deployment logs are private operational artifacts;
credentials, user UUIDs and database dumps are not committed. Current backup
copies are on the same host. Off-host backup delivery and recovery after loss of
the entire host have **not** been demonstrated.

## Roundtrip recovery acceptance — 27 October 2026

The owner confirmed the actual ChatGPT capture-to-Codex roundtrip. A connected
Codex `recall` independently retrieved the same synthetic record before and
after the separately approved live verification. The tested original retained
its exact text, ID, checksum, origin, scope, capture timestamp and `unreviewed`
status. No approval was inferred from its content or origin field.

- The fetched deployment checkout was verified as
  [`dfd0331`](https://github.com/hmbanan666/context/commit/dfd03319a14df47522ef517eb06f0ac6132e2e7d).
  No Sprint 3 branch was merged or deployed. The actual running Context image
  was independently read from Compose as
  `sha256:4bb1852c91b39d761700fd3f8e0d41b5fd89d54f0b45338a799857e7a4ad4ff4`.
- A new SQLite online snapshot contained the selected synthetic source, its
  persistent request key/fingerprint and working FTS; integrity passed.
- A full main-only redeploy completed at 13:27:24 UTC. Actual Context-only
  container recreation followed at 13:29:30 UTC, so a cached no-op was not
  counted as a persistence proof. Exact recall/search passed afterward; replay
  of the stored request returned `duplicate: true` and the original record.
  A forbidden data scope was denied.
- Context alone stopped at 13:31:12 UTC. The snapshot was restored into an
  absent, separate backup-volume database. Integrity, exact source equality,
  FTS, retry identity/fingerprint and wrong-scope absence passed. The original
  live database was never overwritten or replaced.
- The original database runtime restarted at 13:31:21 UTC. Final connected
  recall matched, HTTPS health returned 200, and anonymous MCP returned 401
  with its OAuth challenge. All three Context services were healthy; identity
  services retained their original creation times.
- Temporary verification patches were disabled. Runtime mounts again contained
  only the dedicated data/backups volumes, the normal deployment command was
  restored, and automatic deployment remained disabled.

The private sanitized operational summary is retained with the Context-only
verification artifacts; raw logs, credentials and database snapshots are not
committed. Sprint 2 synthetic acceptance is closed. Off-host backup delivery,
whole-host-loss recovery and real private-memory ingestion remain outside that
demonstration. Sprint 3 deployment is a separate approval.

## Sprint 3 activation — separate from the Sprint 2 live check

The source-material, structured-memory, local-processing and project-access
changes are separate reviewable PRs. They have not been deployed by the
Sprint 2 verification. The base Compose configuration retains the original
pilot's read/write scope and denies processing by default.

To activate synthetic project access after approving and deploying those PRs:

1. Configure an explicit `CONTEXT_CLIENT_GRANTS` JSON map in the Context
   application's private environment. Each configured client requires `read`,
   `write` and `process` arrays; omit a client to deny it completely. See
   `.env.example`. The map is server policy, independent of token claims.
2. In the dedicated Context Keycloak realm, create the chosen synthetic project
   client scopes and `context:process`, with `include.in.token.scope=true`, and
   attach only the intended optional scopes to the relevant existing clients.
   The bootstrap export includes `synthetic:project-a`/`synthetic:project-b`
   examples. Importing that export does **not** update an existing realm.
   Do not enable anonymous registration, widen callbacks or grant other realms.
3. Add the explicit project environment override before the final Dokploy
   network override:

   ```sh
   compose -p <context-app-name> --env-file deploy/.env \
     -f deploy/compose.yaml -f deploy/projects.yaml -f deploy/dokploy.yaml \
     up -d --build --remove-orphans
   ```

4. Reauthorize actual clients for their intended operation and data scopes.
   Queueing requires read, write and process authorization independently.
   Confirm allowed project access and denied foreign-project access through
   actual tools; discovery alone does not prove those operations.

The operator-launched `memory:process` command requires the authoritative local
SQLite file and the separately installed, probed Codex CLI with a ChatGPT login.
It is not a remote worker transport. Do not process an old snapshot and replace
the live database with it: that could discard concurrent writes. The runtime
image contains neither Codex nor subscription credentials; unattended hosted
processing and its credential lifecycle are unverified. No API-key fallback or
subscription credential transfer is introduced by this change.

Owner review uses signed receipts and an independently trusted public key via
`knowledge:review`; no approval tool is exposed through MCP. Actual owner key
provisioning remains separate from synthetic signature tests.

The extended disposable Keycloak smoke verifies real signed project scopes,
the source-material → knowledge → context → queue path, client-specific foreign
project denial even with a signed foreign scope, and missing project/process
scope rejection. The container smoke verifies original file bytes, metadata,
knowledge, queued jobs, FTS and retry identity after restart and isolated restore.
These are test-instance results, not claims about a deployed Sprint 3 service.

No claim in this document authorizes real private-memory ingestion or access
to other Dokploy applications.
