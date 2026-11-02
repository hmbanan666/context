# Hosting, client access and recovery

The [README](../README.md) is the installation guide and single environment-variable
reference. Context needs one container behind HTTPS and persistent SQLite storage.
On 2 November 2026 the owner confirms built-in OAuth/ChatGPT, eval #27 and hybrid
search #28 are deployed. This refactor has not accessed or changed production.

## Existing installations

Keep the database volume, owner/passkeys, `CONTEXT_PUBLIC_URL`, area names and
existing proxy routes. Auth tables, token/client formats, issuer and URL stay
unchanged. Tidy migrates only the relation table CHECK/endpoint constraints,
preserving existing rows. Existing OAuth clients need no
reconnect. New captures are redacted; old records and their checksums stay intact.
Retries of old secret-free requests are unchanged. A retry whose old stored
fingerprint includes now-redacted secrets can conflict; this does not rewrite or
remove the original. Do not blindly generate a new key for such a retry.

The base `deploy/compose.yaml` is the generic one-volume setup with a loopback
port. **Behind Traefik, e.g. Dokploy, also use `deploy/dokploy.yaml`** (Compose
2.24.4+). The overlay removes all published ports, overrides the service network
with the existing external proxy network, and restores the HTTPS/HTTP redirect,
HSTS and rate-limit labels. Traefik connects to internal port 3000; no host port
3000 is reserved. It adds `backups:/app/backups` and fixes
`CONTEXT_BACKUP_DIR=/app/backups`. Base timezone and backup settings are inherited.

Keep the existing `-p` project name: Compose uses it for the existing `_sources`
and `_backups` volume names. Do not change that name or remove volumes on upgrade.
The deployment command remains:

```sh
docker compose -p YOUR_EXISTING_PROJECT --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/dokploy.yaml up -d --build
```

The private `deploy/.env` for this overlay must contain your public MCP URL,
hostname and proxy network. Example (fictional hostname/network):

```dotenv
CONTEXT_PUBLIC_URL=https://context.example/mcp
CONTEXT_HOST=context.example
CONTEXT_PROXY_NETWORK=existing-context-proxy
CONTEXT_AREAS=personal,projects,inbox
TZ=Europe/Berlin
CONTEXT_BACKUP_AT=03:30
CONTEXT_BACKUP_KEEP=7
CONTEXT_BACKUP_TARGET=none
```

`CONTEXT_HOST` must match the URL's hostname. Keep the existing URL unchanged.
The overlay supplies the backup directory; the image defaults the database to
`/app/data/context.db`. No owner password or bearer token belongs in this file.
No `CONTEXT_AUTH` setting is needed.

For off-host copies, replace `none` with `s3` or `sftp` and set the matching
`CONTEXT_BACKUP_S3_*` or `CONTEXT_BACKUP_SFTP_*` variables listed in the
[README](../README.md#settings). Both Compose variants forward every supported
target setting, including nonstandard SFTP ports and an empty S3 prefix. SFTP
also needs its existing private read-only key-file mount retained in a private
override; setting a path alone does not mount the key. Remove the obsolete
`CONTEXT_BACKUP_TIMEZONE`, refresh-lifetime and upload-timeout tuning variables.

Validate without contacting a daemon or starting containers:

```sh
docker compose -p YOUR_EXISTING_PROJECT --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/dokploy.yaml config --quiet
```

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
runs after scheduled backup and tidy attempts, sharing the same schedule and restart
behavior. No extra settings or volumes are required. The SQLite backup does not
include these separate files; preserve them privately if needed. Nightly eval
reuses the server's index/model; standalone eval loads one local model and reports
semantic availability and its contribution against lexical search. See [evals](evals.md).

## Search model and memory

The image includes quantized multilingual E5. Runtime loading is local only;
no model credentials, environment settings or additional volume are needed.
Startup and writes backfill automatically. `context index rebuild` repairs derived
FTS/vectors from preserved originals. Capture does not wait for embeddings.

Compose uses **1536m** for the server plus one standalone eval CLI. The CLI's
measured peak was **646.4 MiB** over 14,550 repeated synthetic chunks. Adding the
owner-reported server RSS (~505 MiB) exceeds the prior 1 GiB limit; 1536m leaves
about 385 MiB headroom, or 218 MiB against the earlier 671 MiB server benchmark
peak. Nightly eval reuses the server model without a second allocation. Run one
standalone model-loading CLI at a time. No new environment variables or volumes
are needed. See [search](search.md#eval-hybrid-calibration) for measurements;
hosted cgroup usage and concurrent workload capacity remain unverified.

## Development and verification

For synthetic loopback development only:

```sh
npm ci && npm run build
CONTEXT_LOCAL_MCP=enabled npm start
```

No-auth mode rejects bearer headers and cannot start in production. With neither
URL nor local opt-in, development exposes health only. Run `npm run check` for
lint, types and all tests; the test runner pins UTC itself. CI additionally runs
`node dist/test/validate-compose.js` against synthetic base/overlay configurations
(no daemon), builds Docker and runs the one-volume restart/restore smoke test.
The Compose check asserts no hosted port binding, stable volume names, proxy
network/labels, timezone and local/S3/SFTP backup configuration.

This refactor's tests cannot establish physical passkey compatibility, hosted
inactivity/next-day refresh, real off-host recovery or a production resource
measurement. Retest save → reopen → ask after a separately approved deployment.

## Nightly tidy

The existing backup schedule now runs backup → tidy → eval, including after a
failed backup attempt. `CONTEXT_BACKUP_AT=off` disables this whole scheduled
chain. Manual use inside the container (or `npm run context -- tidy ...`):

```sh
context tidy --dry-run --json
context tidy --area inbox
```

Dry-run reports proposed relation/move counts and writes neither SQLite nor
history; configured model steps still call the selected processor. Normal runs
append counts (including `llmCalls`), processor, outcome, duration, model and
last-success time to `/app/data/tidy/history.jsonl`. Preserve that file separately if needed; the SQLite
snapshot contains relations/moved areas but not either JSONL history file.

The OpenAI-compatible API remains the default (`CONTEXT_PROCESSOR` unset or
`openai`). Compose forwards the selector and these existing API settings:

- `CONTEXT_LLM_API_KEY`: endpoint credential (a placeholder is enough for a local
  endpoint that requires no authentication).
- `CONTEXT_LLM_MODEL`: provider model name. Both key and model must be nonempty;
  otherwise tidy reports `llm: "not_configured"` and only deduplicates.
- `CONTEXT_LLM_BASE_URL`: defaults to `https://api.openai.com/v1`; set an
  OpenRouter or compatible Ollama/llama.cpp base URL to choose another provider.

Configuring a remote endpoint authorizes sending redacted source text there for
these steps. Keys and source/model response text never appear in tidy history or
logs. No new dependency, timer, service or volume is needed. Standalone tidy reads
stored E5 vectors without loading another model. Missing vectors leave LLM runs
partial so later indexing cannot strand unprocessed facts. Model errors also
leave the successful watermark unchanged. Uncertain/conflicting inbox routing
stays for the owner; a destination with broader existing read grants is skipped.

### Optional Codex subscription processor

Set `CONTEXT_PROCESSOR=codex` to use the CLI's ChatGPT login for tidy and
`memory:process`. `CONTEXT_LLM_MODEL` defaults to `gpt-6-luna`; reasoning effort is
`low`. API credentials/endpoints are ignored. Calls use stdin, an empty temporary
working directory, a read-only sandbox, ephemeral sessions and disabled tools,
MCP, user config, rules and skills instructions. Output is bounded to 128 KiB and
the process group is killed after 180 seconds. No CLI version is pinned; unsupported
flags, missing login/binary and failed calls report `llm: "unavailable"` and leave
tidy doing dedup only. Subscription/model availability and login refresh after
inactivity still need a live check; synthetic tests do not establish them.
Each tidy run first checks `codex login status` once, with a five-second timeout
and discarded output. A failed check skips model steps with `llmCalls: 0`;
dedup still runs and the successful watermark does not advance.

On the host, install a static Codex executable compatible with the container's
Linux architecture (not the npm launcher). Set `CONTEXT_CODEX_BIN` to its absolute
path and `CONTEXT_CODEX_HOME` to a **new dedicated directory**, separate from agent
sessions so token refresh does not collide. Log in directly; never copy agent auth:

```sh
mkdir -p "$CONTEXT_CODEX_HOME"
chmod 700 "$CONTEXT_CODEX_HOME"
CODEX_HOME="$CONTEXT_CODEX_HOME" codex login --device-auth
sudo chown -R 1000:1000 "$CONTEXT_CODEX_HOME"
```

Append `-f deploy/codex.yaml` after `-f deploy/compose.yaml` and, if used,
`-f deploy/dokploy.yaml`. The overlay mounts the binary read-only at
`/usr/local/bin/codex`, the writable login directory at `/app/codex` for uid 1000,
and the host CA bundle read-only at `/etc/ssl/certs/ca-certificates.crt` for static
Codex TLS (host path defaults to the same path; override with
`CONTEXT_CODEX_CA_BUNDLE`; the file must exist because `create_host_path: false`).
Root filesystem read-only, `cap_drop: ALL` and `no-new-privileges` remain;
no SSH or Docker socket is mounted. The CLI alone handles its auth files, including
refresh. [Codex CLI reference](https://developers.openai.com/codex/cli/reference).

Both processors batch up to 25 supersede pairs or inbox items per call, with a
shared hard limit of 12 calls per tidy run. Counts include failed calls. Cursors
retain leftover work for the next night; invalid entries are skipped and counted.
