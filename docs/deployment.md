# Current deployment and recovery

**Stages 1a and 1b merged; stage 1c prepared in PR #21 (2 November 2026).**
The backup slice is not yet merged or deployed. The pilot's last recorded
status comes from [PR #19](https://github.com/hmbanan666/context/pull/19), not a new inspection.
The repository no longer includes identity services; this PR does not change
the live installation.
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
- DCR supports `none`, `client_secret_basic` and `client_secret_post`; omitted
  method defaults to Basic per RFC 7591. Public/native clients should request
  `none`; existing public registry entries stay public. Unknown optional metadata
  is ignored. Confidential secrets are returned once, valid until revocation
  (`client_secret_expires_at: 0`); only hashes persist, separately from listings.
  Lost secrets require new registration and revocation of the old client.
- Token exchange, refresh and revocation enforce the registered method. Basic
  credentials use form encoding before Base64; POST secrets belong in the form
  body, never the URL. Missing/wrong credentials or method downgrades fail with
  `invalid_client`; mixed authentication methods are rejected. S256 PKCE and exact
  resource binding remain mandatory for every client.
- Callbacks must exactly match registered HTTPS, IP-loopback HTTP or hierarchical
  private-use app URIs, including `cursor://anysphere.cursor-mcp/oauth/callback`
  and `com.example.fictional:/oauth/callback`. No wildcards, fragments, userinfo,
  executable/file schemes (`javascript:`, `data:`, `file:`) or arbitrary HTTP.
  Consent shows the self-declared name, callback and requested area/operation
  pairs; the owner narrows rights and selects a default write area. Registration
  and possession of a client secret do not grant memory access.
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

## Import existing archives

Run `context import jsonl --source NAME --area AREA` inside the container using
its existing `CONTEXT_DB_PATH` and `CONTEXT_AREAS`. Feed stdin or `--file PATH`.
GitHub/Codex collectors run on the operator machine; they need no database access.
See [imports](imports.md) for commands, redaction, immutable revisions and results.
No new environment variables, services or volumes are required. The additive
`source_imports` table/index ships with the code and is covered by SQLite backups.
Deployment and real-data ingestion remain distinct owner actions.

## Backup and restore today

After building, use a local synthetic database and new private filenames:

```sh
npm run database -- backup ./data/context.db ./backups/context-snapshot.db
npm run database -- restore ./backups/context-snapshot.db ./data/restored.db
```

Online backup includes committed WAL pages, sources, derived records, jobs,
indexes, retries, owner password hash, passkey public keys, client secret hashes
and token hashes.
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

### Nightly schedule and off-host delivery


The Context process makes a SQLite online snapshot nightly, checks `quick_check`,
restores it into a temporary separate file and opens/checks that restored copy.
Only verified snapshots become `context-<UTC timestamp>-<UUID>.db` files. Originals,
BLOBs, indexes, retry keys and every `auth_*` table stay together. No host cron or identity provider is
needed for backups. This implementation is release preparation, not live activation.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTEXT_BACKUP_DIR` | `./backups` | Dedicated writable, persistent local directory; `/app/backups` in the image's working directory. |
| `CONTEXT_BACKUP_AT` | `03:30` | Daily local `HH:MM`; `off` disables scheduling but allows the CLI. |
| `CONTEXT_BACKUP_TIMEZONE` | Process timezone | IANA timezone, e.g. `Europe/Berlin`; containers normally use UTC. |
| `CONTEXT_BACKUP_KEEP` | `7` | Retain 1–3650 verified local snapshots, including manual runs. |
| `CONTEXT_BACKUP_TARGET` | `none` | `none` (local only), `s3`, or `sftp`. |
| `CONTEXT_BACKUP_TIMEOUT_MS` | `300000` | Whole upload deadline, 1000–3600000 ms. |
| `CONTEXT_BACKUP_S3_ENDPOINT` | Required for S3 | HTTPS S3-compatible endpoint without embedded credentials/query/fragment; path-style addressing. |
| `CONTEXT_BACKUP_S3_REGION` | Required for S3 | Signing region accepted by the target. |
| `CONTEXT_BACKUP_S3_BUCKET` | Required for S3 | Existing private bucket. |
| `CONTEXT_BACKUP_S3_PREFIX` | `context/` | Object key prefix; empty is allowed. |
| `CONTEXT_BACKUP_S3_ACCESS_KEY` / `CONTEXT_BACKUP_S3_SECRET_KEY` | Required for S3 | Dedicated credentials, supplied privately through the environment. |
| `CONTEXT_BACKUP_SFTP_HOST` / `CONTEXT_BACKUP_SFTP_PORT` | Host required / `22` | SFTP destination. |
| `CONTEXT_BACKUP_SFTP_USER` | Required for SFTP | Dedicated remote account. |
| `CONTEXT_BACKUP_SFTP_PRIVATE_KEY_PATH` | Required for SFTP | Readable mounted private key; encrypted private keys are not supported in this slice. |
| `CONTEXT_BACKUP_SFTP_REMOTE_DIR` | Required for SFTP | Existing private absolute directory with write/rename rights. |
| `CONTEXT_BACKUP_SFTP_HOST_KEY_SHA256` | Required for SFTP | Trusted SHA-256 host-key fingerprint as 64 hex digits; mismatches fail closed. |

[Base Compose](../deploy/compose.yaml) passes these settings to Context and fixes
`CONTEXT_BACKUP_DIR=/app/backups` on the existing backup volume. Its timezone
default is UTC. Unused S3/SFTP variables may be empty; only the selected target's
required fields are validated. An empty SFTP port uses 22. An unset S3 prefix
uses `context/`; explicitly empty means the bucket root. No optional env file is
required. For SFTP, add a read-only key-file mount through a private Compose
override and set `CONTEXT_BACKUP_SFTP_PRIVATE_KEY_PATH` to that container path.
The base file does not mount or discover host keys/credentials automatically.

After startup, the scheduler checks every 30 seconds. If today's time has passed,
it catches up once; it does not replay all missed days. Completed and failed
scheduled attempts persist their local calendar date across restarts. An
interrupted attempt is retried after restart. A daylight-saving gap runs at the
first later local minute; a repeated hour does not duplicate the daily attempt.
A lock coordinates scheduled and CLI backups and releases automatically on exit.
Use one local backup directory per database, on a filesystem with SQLite locking.

Retention runs after verification and before upload. It removes only generated
snapshot names, preserving unrelated files and the current snapshot even after
clock changes. Failed uploads keep that verified local snapshot. The next nightly
attempt sends a fresh complete snapshot; `npm run backup` retries immediately
with a new snapshot. There is no queue of old failed uploads. S3 uses a streaming
single PUT (up to the provider's single-object PUT limit); SFTP streams a private
`.part` file, checks its size, then renames it. Remote retention is **not** applied:
configure the bucket lifecycle or remote cleanup, including abandoned `.part`
files. An upload acknowledgement is not a remote restore drill.

```sh
npm run build
npm run backup                # verified snapshot, retention, configured upload
npm run backup -- status      # owner-only last result; nonzero unless successful
npm run database -- restore ./backups/CHOSEN-SNAPSHOT.db ./data/recovered.db
```

In the image, use `node dist/scripts/backup.js run` / `status` and
`node dist/scripts/database.js restore SOURCE NEW_DESTINATION`. These CLI commands
use filesystem access as owner authority; they do not require MCP or OAuth.
Restore refuses an existing destination or its WAL/SHM sidecars. It never selects
or replaces the live database. Stop Context before deliberately switching its
database path to a recovered file. For an off-host restore, download the snapshot,
compare SHA-256 with the recorded checksum, then use the same restore command.

`status.json` and snapshots are mode `0600`; newly created backup directories are
`0700`. Status is local only, read through the CLI; public `/health` stays unchanged.
Logs contain only backup metadata (name, bytes, SHA-256, timestamps, duration,
stage and outcome), never raw errors, records, endpoints or credentials. Failures
do not stop capture/recall. Invalid backup configuration disables scheduling and
logs `stage: configuration`; it never silently falls back to local-only success.
The last status file may then describe an older attempt; check its timestamp and
startup logs. Filesystem failures that prevent writing status are logged too.

Persist the backup directory separately from the container's disposable layer.
Budget for retained snapshots plus two temporary full database copies during
verification. `none` does not protect against host loss. Transfers use TLS or SSH;
**client-side backup encryption is a follow-up**. Local and remote files contain
the complete SQLite database, so keep both destinations private. Configuration and external credentials need separate recovery; this backup copies
SQLite, including the built-in authentication state, only. No real remote-storage or hosted recovery claim
is made by the synthetic tests.

## Retrieval evaluation

The owner CLI supports `context eval run [--questions PATH] [--k 10] [--json]`
and `context eval history [--limit 10] [--json]`. Put private questions at
`/app/data/evals/questions.yaml`; summary rows append to
`/app/data/evals/history.jsonl` on the existing data volume. The main database
is opened read-only. No new environment variables, auth credentials, volumes or
scheduler configuration are required. Nightly eval runs immediately after the
existing scheduled backup attempt when the file exists; backup scheduling off
also disables eval. The SQLite backup does not include these separate files.
See [eval schema, metrics, privacy and limits](evals.md). Hosted private quality
and performance under the container memory limit have not been measured here.

## Verification and limits

Run `npm ci` and `npm run check` with pinned Node/npm. Checks cover source/knowledge
preservation, auth/CLI, software-authenticator passkeys, official SDK OAuth/MCP,
confidential clients, exact native callbacks, expiry, replay/revocation, HTTP
limits and backup/restore. `npm run test:oauth` replaces the removed Keycloak
provider smoke test. GitHub CI also builds the image
and runs `npm run test:container` with disposable synthetic data. Docker is not
available in this work environment and was not invoked locally; use CI evidence.
Review Markdown links and current/target consistency separately from Biome.

Actual hosted ChatGPT/Claude/Cursor linking, physical/synced passkeys, proxy routing
and real next-day save → reopen → ask remain unverified. No live acceptance or
migration is claimed. See [spec acceptance](spec.md#testing-decisions); discovery
and fixture tests do not replace actual-client journeys. Protocol references:
[MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
and [WebAuthn verification](https://simplewebauthn.dev/docs/packages/server).
