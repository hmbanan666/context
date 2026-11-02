# Current deployment and recovery

**Pilot running; stage 1 in progress (2 November 2026).** Current status comes
from repository configuration and the [PR #19 release record](https://github.com/hmbanan666/context/pull/19),
not a new live inspection. Every merge, deployment or live configuration change
requires separate explicit owner approval. This docs-only change authorizes none.

## Current protected setup

The pilot uses Context, **Keycloak and its dedicated PostgreSQL database** behind
HTTPS. Context stores memory in SQLite on its own persistent volume; Keycloak's
PostgreSQL stores identity state, not memory. Keycloak remains required until
stage 1b ships. The target one-command `docker run` setup is not available today;
use the [README](../README.md#quick-start-today-local-synthetic-development) for
an isolated local synthetic start.

The repository's deployment files remain the current configuration reference:

- [Base Compose](../deploy/compose.yaml): Context, Keycloak, identity database and
  dedicated volumes; [bootstrap](../deploy/bootstrap.yaml) is for initial identity setup.
- [Project grants](../deploy/projects.yaml) and [personal mode](../deploy/personal.yaml):
  explicit server policy and protected personal-tool opt-in.
- [Hosting overlay](../deploy/dokploy.yaml): Context-specific network isolation.
- [Keycloak configuration](../deploy/keycloak/) and the existing ChatGPT compatibility
  profile: pre-registered clients and the approved default-scope behavior.
- [Environment reference](../.env.example): export variables explicitly; `.env`
  is not loaded by the application itself.

Protected application settings require `CONTEXT_AUTH=oauth`,
`CONTEXT_PUBLIC_URL=https://context.kosarev.space/mcp`,
`CONTEXT_OAUTH_ISSUER=https://context.kosarev.space/auth/realms/context` and the
configured `CONTEXT_OWNER_SUBJECT`. These URLs are pinned in current validation.
Personal mode additionally requires `CONTEXT_PERSONAL_MEMORY=enabled` and explicit
`CONTEXT_CLIENT_GRANTS` read/write entries for `private:personal`. Retain existing
approved grants when changing a map. Never publish actual owner IDs or credentials.

Current owner login is handled by Keycloak with its existing password/MFA setup;
pre-registered ChatGPT/Codex clients use their configured callbacks and grants.
The approved built-in password + passkey login, DCR and CLI tokens are stage 1b
work. Existing connections **must reconnect** when that replacement ships.
A realm bootstrap import does not update an existing realm.

The resource server rejects absent/invalid credentials and intersects signed
OAuth scopes with server grants. Revoking a provider session or refresh grant
can leave an issued access token valid for up to five minutes. Removing server
grants takes effect after configuration reload/restart. The target revocable
client/token management is not claimed as already implemented.

## Backup and restore today

The current mechanism is an explicit SQLite online snapshot followed by a private
off-host copy. After building, these commands can be used on a **local synthetic
database** (choose a new snapshot name each time):

```sh
npm run database -- backup ./data/context.db ./backups/context-snapshot.db
npm run database -- restore ./backups/context-snapshot.db ./data/restored.db
```

Backup uses SQLite's online backup API, including committed WAL pages, and checks
source integrity. Restore is offline: stop the target instance first, use an
absent destination with no `-wal`/`-shm` sidecars, then point `CONTEXT_DB_PATH` at
the restored file. Neither operation overwrites an existing destination. Validate
restored integrity, source IDs/checksums, provenance, retry identity, search and
access denial before using the copy. Never replace concurrent live writes with
an older snapshot or copy a live SQLite file while ignoring its WAL.

Until stage 1b removes the identity service, recovery also requires a private
backup of Keycloak's dedicated PostgreSQL database and the instance configuration.
A realm JSON bootstrap export is not that database backup. Restoring identity
state must be separately verified with the matching provider version.

Point-in-time off-host copy and isolated restore are recorded in the release PR;
**nightly scheduling and configurable SFTP/S3-compatible delivery are not shipped**.
A same-host backup volume does not cover host loss. Stage 1c adds automated delivery
and recovery checks. Backup contents and target credentials stay outside Git.
Future hard-delete acceptance must define retention and restore reconciliation
so a recovered copy cannot silently reintroduce owner-deleted content.

## Verification and limits

Run the pinned Node/npm versions with `npm ci` and `npm run check`. The latter
runs Biome, type checks, compilation and tests. Biome excludes Markdown, so docs
also need link and consistency review. GitHub CI additionally builds the image,
runs `npm run test:container` and `npm run test:oauth-provider` with disposable
synthetic data. The two smoke suites require Docker and Python 3. When Docker is
unavailable locally, state that limit and use the CI results; do not claim local
container/provider verification.

Recorded pilot save/read/retry, short-idle refresh and isolated recovery passed.
Actual external `context_package` invocation, forty-minute/next-day personal
client inactivity and independent personal cross-client acceptance remain
unverified in the latest release record. No new live check is claimed here.
Discovery and fixture-provider tests do not establish those user journeys.
The full [spec acceptance](spec.md#testing-decisions) requires actual-client
save/reopen/ask and revocation evidence as well as automated checks.
