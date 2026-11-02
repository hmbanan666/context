# Hosting, client access and recovery

The [README](../README.md) is the installation guide and single environment-variable
reference. Context needs one container behind HTTPS and persistent SQLite storage.
On 2 November 2026 the owner confirms built-in OAuth/ChatGPT, eval #27 and hybrid
search #28 are deployed. This refactor has not accessed or changed production.

## Existing installations

Keep the database volume, owner/passkeys, `CONTEXT_PUBLIC_URL`, area names and
existing proxy routes. No auth table, token/client format, issuer, URL or database
migration changes in the simplicity refactor. Existing OAuth clients need no
reconnect. New captures are redacted; old records and their checksums stay intact.
Retries of old secret-free requests are unchanged. A retry whose old stored
fingerprint includes now-redacted secrets can conflict; this does not rewrite or
remove the original. Do not blindly generate a new key for such a retry.

The new Compose file is a portable **fresh-install example**, not a replacement
for a configured production proxy stack. It binds to host loopback and contains
no Traefik/Dokploy networks or labels. Keep the existing production Compose/proxy
configuration when upgrading an image, including its source and backup volumes.
The old `deploy/dokploy.yaml` overlay only repeated the base network and is removed.
No automatic volume or network conversion is performed.

For an existing separate backup volume, keep `CONTEXT_BACKUP_DIR=/app/backups`
and its mount. New installs put backups in `/app/data/backups` on the data volume.
If a previous checkout used the default `./backups`, explicitly set
`CONTEXT_BACKUP_DIR=./backups` to retain its snapshots and scheduler status.
Never recreate a volume or initialize an owner to perform this upgrade.

Removed tuning: refresh deadlines are fixed at the previous defaults (one day,
or 30 days with offline consent), upload timeout at five minutes. Stored token
expiry/family deadlines are untouched. Replace `CONTEXT_BACKUP_TIMEZONE` with `TZ`
if used. Old Keycloak/grants flags have no effect; current grants come exclusively
from SQLite. `CONTEXT_AUTH=oauth` is still accepted but is unnecessary with a URL.

## Authentication

Forward `/mcp`, `/auth/*`, `/oauth/*` and `/.well-known/*` to port 3000 using the
public Host header. The exact HTTPS MCP URL is the token audience; its origin is
the issuer, WebAuthn origin and RP host. Discovery supports RFC 9728/8414. Avoid
logging bearer/cookie headers, request bodies or authorization callback queries.

DCR supports public `none` and confidential `client_secret_basic`/
`client_secret_post` clients (Basic by default). Registered redirects match
exactly: HTTPS, IP-loopback HTTP and hierarchical private-use callbacks are
supported. S256 PKCE and resource binding are required. Registration grants no
memory rights; the owner consents to bounded areas/operations. Confidential
secrets print once and are stored as hashes; method downgrade is rejected.

`context owner init` reads a password twice with terminal echo disabled, or once
from stdin for automation. It refuses to overwrite an initialized owner. First
OAuth login requires passkey enrollment; subsequent logins require password and
passkey. Use a browser with native WebAuthn JSON support. Retain a synced passkey:
there is no passkey recovery/management UI. Never delete the database to reset login.

Access tokens last five minutes. Refresh authorization lasts one day, or 30 days
with separately consented `offline_access`; rotation retains the original family
deadline. Replay of a consumed code or refresh token revokes that family.

Inside the container (or `npm run context -- ...` in a built checkout):

```sh
context token create coding-agent --read projects --write projects --default-write projects
context client list
context token list
context token revoke TOKEN_ID
context client revoke CLIENT_ID
```

Tokens print once and expire in 90 days by default; `--expires` accepts bounded
`m`, `h`, `d` durations up to one year. Optional `--process projects` also requires
read/write rights. Reusing a CLI client name can add rights to its registry but
never broadens older tokens. Revoked names cannot be reused. Revocation is checked
on every request. CLI commands use owner filesystem authority, not network login.

## Backups

At 03:30 local time, Context takes an online SQLite snapshot, checks integrity,
restores it to a separate temporary file, and verifies that copy. Seven generated
snapshots are retained by default. Sources, files, knowledge, jobs, retry identity,
indexes and all `auth_*` tables travel together. Configuration and external
credentials need separate recovery. Allow space for retention plus two temporary
full copies. Backup errors do not stop capture/search.

Scheduling checks every 30 seconds, catches up once after today's scheduled time,
and persists the attempted calendar date. An interrupted run retries on restart;
a completed failure waits until the next night or a manual retry. SQLite locking
coordinates CLI and scheduled runs. Use one local backup directory per database.

```sh
# Inside the running container:
node dist/scripts/backup.js run
node dist/scripts/backup.js status
# In a built checkout: npm run backup / npm run backup -- status
```

Status distinguishes a verified local snapshot from an uploaded copy. A failed
upload keeps the local snapshot. Retrying creates and sends a fresh complete
snapshot, not a queue of previous failures. Status and snapshots are mode `0600`;
new backup directories are `0700`. Logs contain metadata and stages, not records,
credentials or raw remote errors. Invalid target configuration disables scheduling
with a configuration failure; inspect timestamps because status may describe an
older run.

Optional targets use the [README settings](../README.md#settings):

- **S3:** an existing private bucket and HTTPS endpoint, path-style single PUT,
  streaming uploads. Set a remote lifecycle policy; Context only prunes local copies.
- **SFTP:** an existing private absolute directory, a mounted unencrypted key file,
  and a trusted SHA-256 host-key fingerprint (64 hex digits). Uploads use a private
  `.part` file, verify size and rename. Arrange cleanup of stale partial/old files.

Both transfer over TLS/SSH and store plain SQLite snapshots. Client-side encryption
is explicitly out of scope ([ADR 0009](adr/0009-nightly-off-host-backups.md)).
A same-host copy cannot survive host loss, and an upload acknowledgement alone is
not a remote recovery drill.

Restore offline into a **new** destination, never over the live database:

```sh
node dist/scripts/database.js restore /app/data/backups/CHOSEN.db /app/data/recovered.db
# Existing two-volume installs use /app/backups/CHOSEN.db instead.
# In a checkout: npm run database -- restore SOURCE NEW_DESTINATION
```

For an off-host copy, download it privately and compare SHA-256 with the recorded
checksum first. Restore rejects existing files and WAL/SHM sidecars. Stop Context
before deliberately switching its database path. Reconcile credentials revoked
since the snapshot before reopening access. The future hard-delete feature must
also define deletion reconciliation; it is not implemented today.

## Retrieval evaluation

`context eval run` and `context eval history` use the main database read-only.
Private questions live at `/app/data/evals/questions.yaml`; numeric results and
question IDs append to `/app/data/evals/history.jsonl`. When questions exist, eval
runs after scheduled backup attempts, sharing the same schedule and restart
behavior. No extra settings or volumes are required. The SQLite backup does not
include these separate files; preserve them privately if needed. See [evals](evals.md).

## Search model and memory

The image includes quantized multilingual E5. Runtime loading is local only;
no model credentials, environment settings or additional volume are needed.
Startup and writes backfill automatically. `context index rebuild` repairs derived
FTS/vectors from preserved originals. Capture does not wait for embeddings.

The merged search implementation recommends **1 GiB**, retained in Compose and the
README: its synthetic measurements reached roughly 661–671 MiB RSS. Do not reuse the earlier
512 MiB limit for that workload. The owner confirms search is deployed; this task
has not inspected its current limits. This refactor adds no memory requirement. See [search](search.md)
for measured bounds; live concurrency and capacity remain unverified.

## Development and verification

For synthetic loopback development only:

```sh
npm ci && npm run build
CONTEXT_LOCAL_MCP=enabled npm start
```

No-auth mode rejects bearer headers and cannot start in production. With neither
URL nor local opt-in, development exposes health only. Run `npm run check` for
lint, types and all tests. CI additionally builds Docker, checks Compose defaults
and runs the one-volume container restart/restore smoke test.

This refactor's tests cannot establish physical passkey compatibility, hosted
inactivity/next-day refresh, real off-host recovery or a production resource
measurement. Retest save → reopen → ask after a separately approved deployment.
