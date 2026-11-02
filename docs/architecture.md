# Current architecture

As recorded on **2 November 2026**, the protected pilot runs the implementation
released in [PR #19](https://github.com/hmbanan666/context/pull/19). This document
describes repository behavior and recorded release status, not a new inspection
of the live service. Stages 1a and 1b are merged; stage 1c backups are prepared in
PR #21, not yet merged or deployed. The [spec](spec.md) and [ADRs](adr/) define
the approved target; this backup slice does not claim the later capabilities.

## Runtime and access

The core is a Node/TypeScript service using the MCP SDK with Streamable HTTP at
`/mcp`, a separate `/health` endpoint and SQLite persistence. The container runs
as a non-root user with persistent data storage.

**The core is now the authorization server and resource server.** Keycloak and
its dedicated PostgreSQL services/configuration are removed from the repository.
The configured public HTTPS `/mcp` URL is the exact audience; its origin is the
issuer. RFC 9728/8414 discovery, DCR, authorization code + mandatory S256 PKCE,
owner password/passkey login, narrowable consent and revocation are built in.
DCR supports public (`none`) and confidential (`client_secret_basic` /
`client_secret_post`) clients; new registrations default to Basic, while existing
public entries stay public. Secrets are returned once and stored only as hashes
in `auth_client_secrets`, separately from listings. Token/refresh/revocation
requests enforce the registered method; unknown optional DCR metadata is ignored.
HTTPS, IP-loopback HTTP and hierarchical private-use callbacks are exact-matched;
executable/file schemes, fragments and userinfo are rejected.

The SQLite registry records clients, rights, redirects, default write area,
creation/last-use and revocation. Public and confidential clients begin with no
rights. OAuth and CLI bearer credentials are random 256-bit opaque values stored
only as SHA-256 hashes; each request intersects their own approved area/operation
pairs with current client grants. Revocation takes effect on the next request.
Access lasts five minutes; rotating refresh families have configurable absolute
normal/offline deadlines. Replaying a consumed code or refresh token revokes all
family descendants. Consumption/rotation use SQLite transactions.

`context owner init` sets the password using Node scrypt (N=32768, r=8, p=3).
First password login requires passkey enrollment; later logins require both.
SimpleWebAuthn verifies challenge, origin, RP ID, signature and user verification.
Ten-minute owner sessions use Secure/HttpOnly/SameSite=Lax host-only cookies,
CSRF and exact Origin checks. Auth bodies and request rates are bounded.

`CONTEXT_AREAS` defines 1–8 areas, defaulting to `personal`. The wire field remains
`scope`; default routing grants no access. Protected `remember` uses the
credential's default write area; inbox sorting remains future work. Local no-auth
MCP uses `CONTEXT_LOCAL_MCP=enabled`, is loopback-only for fictional development/
test data, and is rejected in production. See [deployment](deployment.md) for
client authentication methods, callback validation and CLI configuration.

## Sources and retrieval

Sources, material metadata, original text-file bytes, checksums and retry identity
are stored in SQLite. Capture is transactional and preserves input before optional
interpretation. Today's capture does **not** implement the approved secret-redaction
pipeline or hard-delete contract; do not infer those protections from the target spec.
The owner-local [JSONL import path](imports.md) adds deterministic redaction for
imports and both collectors, preserving source attribution in `source_imports`.
Each changed external item becomes a new immutable source linked by source name
and external ID; exact version retries reuse the retained source. Imports share
the existing source/search tables and area-checked retrieval.

The primary memory tools are:

| Tool | Current behavior |
| --- | --- |
| `remember` | Saves text and optional metadata in an authorized area (protected default: credential's default write area; local default: `personal`), records authenticated-client origin and returns stable identity on unchanged retries. Does not enqueue processing. |
| `memory_context` | Pages originals by source date (capture date if absent), with optional any-keyword FTS, continuation and explicit oversized-source reporting. |
| `context_package` | Returns bounded lexical/timeline evidence from originals and stored knowledge, with excerpts, provenance, status and at most one hop of stored relations. |
| `read_material` / `read_knowledge` | Retrieves a referenced original or derived item under fresh authorization checks. |

`remember`, `memory_context` and `context_package` accept an authorized `scope`,
defaulting to `personal` except protected `remember` as described above. Clients
supply explicit date boundaries and inspect coverage/truncation. A package is not
an exhaustive archive scan; paged original retrieval handles full periods.
Current FTS has no Russian/English morphological pipeline or semantic embeddings.
Derived knowledge is source-grounded but is not yet the approved automatically
maintained understanding layer with deduplication and superseding.

## Processing and legacy interfaces

A durable processing queue supports leases, retries and replay of saved validated
output. An operator-launched local Codex CLI extraction path exists for synthetic
experiments. The runtime image contains neither Codex nor subscription credentials;
unattended hosted processing and its credential lifecycle remain unverified.
Capture and retrieval do not require an inference provider.

Stage 1a removes Ed25519 review/signature and work/GitHub evidence code,
`knowledge_history`, `work_context` and `project_context`, plus their scripts and
fixtures. Synthetic test data remains required. The retained 15 tools include
`capture`/`recall` for existing retry contracts and exact-ID/phrase lookup alongside
the material, memory, knowledge and processing tools. GitHub PR import in stage 2
is a separate source-ingestion feature.

## Recovery and transition

SQLite online backup and offline restore commands exist; they include sources,
derived records, jobs, indexes, retry state and auth state. PR #21 adds in-process
nightly snapshots, local retention, verified separate-file restore and optional
S3/SFTP delivery; actual hosted off-host recovery is unverified. No startup
migration drops or rewrites existing rows. Old work tables remain unused;
historical review rows still supply knowledge status, including
rejection filtering, without a review writer. Existing area names and retry keys
are preserved. See [deployment](deployment.md) for compatibility and recovery.

Stage 1b preserves source/knowledge rows and adds only auth tables. Existing
ChatGPT/Codex and other Keycloak connections must reconnect to the built-in
issuer; no migration or deployment was performed here. Later stages add
imports/evals, morphology/local embeddings, pluggable understanding and owner controls. An inferred topic never grants area access.
Consult the [glossary](../CONTEXT.md) when naming these concepts.
