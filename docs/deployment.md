# Current deployment and recovery

**Stage 1a merged; stage 1b implementation done in PR #23 (2 November 2026).**
Stage 1b is not yet merged or deployed. The pilot's last recorded status comes
from [PR #19](https://github.com/hmbanan666/context/pull/19), not a new inspection.
This PR removes identity services from the repository, not the live installation.
Merge, deployment and live changes remain distinct approval/action steps.

## Current protected setup

The core now provides built-in OAuth 2.1 and owner password + passkey login, with
memory and auth state in SQLite. [Base Compose](../deploy/compose.yaml) contains
only Context and its data/backup volumes; Keycloak, its PostgreSQL database,
bootstrap and realm files are removed. The [hosting overlay](../deploy/dokploy.yaml)
keeps Context network isolation. Compose uses `CONTEXT_HOST` and
`CONTEXT_PROXY_NETWORK` for an existing HTTPS proxy. No proxy or server was changed.
See the [README](../README.md#quick-start-today-local-synthetic-development) for
local synthetic development. The fully automatic one-command product remains a target.

After building with the pinned Node/npm versions, configure protected access:

```sh
export CONTEXT_AUTH=oauth
export CONTEXT_PUBLIC_URL=https://context.example/mcp
export CONTEXT_DB_PATH=./data/context.db
export CONTEXT_AREAS=personal,garden
npm run context -- owner init
NODE_ENV=production npm start
```

The packaged/image CLI is `context`; in a checkout use `npm run context -- ...`.
`owner init` reads a password twice without terminal echo, or once from stdin for
automation, and refuses to overwrite an existing owner. Never put passwords in
arguments. First OAuth login enrolls a passkey after password verification; later
logins require both. Use a current browser with native WebAuthn JSON support.
There is no password-only fallback or passkey recovery/management UI in this slice;
retain the enrolled/synced passkey and private backups. Do not reset auth by
removing the memory database.

- Resource/audience is the exact HTTPS `CONTEXT_PUBLIC_URL` ending in `/mcp`;
  issuer and passkey origin are its origin. Discovery is at
  `/.well-known/oauth-protected-resource/mcp` (also the root alias) and
  `/.well-known/oauth-authorization-server`. Forward `/mcp`, `/auth/*`, `/oauth/*`
  and `/.well-known/*` to Context with the public Host header. Prevent direct
  public HTTP access to the backend. Do not log Authorization/Cookie headers,
  request bodies or callback queries containing codes; Context logs no credentials.
- DCR grants no memory access. Owner consent shows the self-declared client name,
  callback and requested area/operation pairs; the owner narrows rights and
  selects a default write area. S256 PKCE and exact resource binding are required.
- Access tokens last five minutes. `CONTEXT_REFRESH_SECONDS` defaults to 86400
  (range 300–2592000). Separately consented `CONTEXT_OFFLINE_SECONDS` defaults to
  2592000 (up to 31536000 and at least the normal lifetime). Refresh rotates once;
  reuse revokes the whole family, including access tokens. Rotation cannot extend
  the original absolute deadline. Expired/revoked families require reconnecting.
- Owner sessions last ten minutes with Secure/HttpOnly/host-only SameSite=Lax
  cookies, CSRF and exact Origin checks. Auth bodies are limited to 16 KiB.
  Single-owner per-minute limits are login 10, token 120, DCR 10,
  authorization/passkeys 30 and revocation 60; MCP allows 60 per client. Limits
  reset on restart. Capacity is 256 active clients and 1024 browser sessions;
  revoke unwanted clients to free registry capacity.
- `CONTEXT_AREAS` defines 1–8 areas (default `personal`). Unknown/ungranted areas
  fail closed; automatic inbox classification is not implemented. Production
  requires protected configuration; local no-auth mode is loopback/dev/test only.
  Export settings explicitly; [`.env.example`](../.env.example) is not auto-loaded.

Headless credentials share OAuth's area checks and live revocation:

```sh
context token create fictional-worker --read personal,garden --write garden --default-write garden --expires 90d
context client list
context token list
context token revoke TOKEN_ID
context client revoke CLIENT_ID
```

Tokens print once; only hashes persist. Expiry defaults to 90 days and is bounded
to one year (`m`, `h`, `d` durations). Optional `--process area` additionally needs
read/write rights. Reusing a CLI client name adds rights to its registry but never
broadens older tokens; revoked names cannot be reused. Listings expose IDs, rights,
redirects, default write area and timestamps, never credentials. Revocation takes
effect on the next request; revoking an OAuth token revokes its whole family.
Expired OAuth families are pruned after their final access lifetime; CLI history
remains listed. Protected `remember` uses the credential's default write area.

**Migration/reconnect:** existing ChatGPT/Codex and other Keycloak-issuer
connections stop working after this release and must reconnect once through
standard MCP OAuth. Keep the SQLite volume and legacy area names. Remove
`CONTEXT_OAUTH_ISSUER`, `CONTEXT_OWNER_SUBJECT` and `CONTEXT_CLIENT_GRANTS` (old
settings fail startup), initialize the owner and approve new registry grants.
New client IDs change MCP provenance; replaying old writes through a new client
is not a migration tool. Sources, knowledge, files and retry rows are unaffected.
Keycloak containers and their dedicated database can be removed after the switch
under the applicable owner approval; retain private backups for rollback. This
PR does not perform that migration or delete live containers/volumes.

The 1a compatibility rules still apply: remove `CONTEXT_PERSONAL_MEMORY`, replace
local `CONTEXT_LOCAL_SCOPES` with `CONTEXT_AREAS`, and opt in with
`CONTEXT_LOCAL_MCP=enabled`. Retain original areas such as `private:personal` and
use their original `scope` for reads/retries. Removed tools are `knowledge_history`,
`work_context` and `project_context`; removed scripts are `knowledge:review`,
`work` and `work:probe`. Use memory/context tools; `capture`/`recall` remain.
Old work tables are unused; historical review rows preserve knowledge status.
No startup code drops or rewrites domain rows. Rollback needs matching code and
provider configuration; never replace concurrent writes with an old snapshot.

## Backup and restore today

After building, use a local synthetic database and new private filenames:

```sh
npm run database -- backup ./data/context.db ./backups/context-snapshot.db
npm run database -- restore ./backups/context-snapshot.db ./data/restored.db
```

Online backup includes committed WAL pages, sources, derived records, jobs,
indexes, retries, owner password hash, passkey public keys and token hashes.
Commands check integrity and refuse to overwrite destinations. Restore offline
to an absent file without WAL/SHM sidecars; stop the service before switching
`CONTEXT_DB_PATH`. Verify source IDs/checksums, provenance, retries, search and
access denial. Never copy a live SQLite file while ignoring its WAL.

Restoring auth state also rolls back revocations/refresh rotation: revoke restored
credentials and require reconnect/reissue before external access if the snapshot
predates revocations. During a Keycloak rollback window, retain its separate
private identity database backup; realm JSON is not a database backup. Backup
contents and credentials stay outside Git. Future hard-delete acceptance must
address retention and restore reconciliation.

**Nightly scheduling and configurable SFTP/S3-compatible delivery remain stage
1c work.** A same-host backup volume does not cover host loss; retain a verified
private off-host copy and test isolated restore.

## Verification and limits

Run `npm ci` and `npm run check` with pinned Node/npm. Checks cover source/knowledge
preservation, auth/CLI, software-authenticator passkeys, official SDK OAuth/MCP,
expiry, replay/revocation, HTTP limits and backup/restore. `npm run test:oauth`
replaces the removed Keycloak provider smoke test. GitHub CI also builds the image
and runs `npm run test:container` with disposable synthetic data. Docker is not
available in this work environment and was not invoked locally; use CI evidence.
Review Markdown links and current/target consistency separately from Biome.

Actual hosted ChatGPT/Claude/Cursor linking, physical/synced passkeys, proxy routing
and real next-day save → reopen → ask remain unverified. No live acceptance or
migration is claimed. See [spec acceptance](spec.md#testing-decisions); discovery
and fixture tests do not replace actual-client journeys. Protocol references:
[MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
and [WebAuthn verification](https://simplewebauthn.dev/docs/packages/server).
