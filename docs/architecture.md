# Current architecture

As recorded on **2 November 2026**, the protected pilot runs the implementation
released in [PR #19](https://github.com/hmbanan666/context/pull/19). This document
describes repository behavior and recorded release status, not a new inspection
of the live service. The [spec](spec.md) and [ADRs](adr/) define the approved target.

## Runtime and access

The core is a Node/TypeScript service using the MCP SDK with Streamable HTTP at
`/mcp`, a separate `/health` endpoint and SQLite persistence. The container runs
as a non-root user with persistent data storage.

**Keycloak is still the authorization server**, backed by its dedicated
PostgreSQL database. Context is the resource server: it verifies signed tokens,
issuer, audience, expiry, owner and the two recognized pilot client identities.
Operation/data OAuth scopes intersect with independent server grants. Missing or
invalid authentication is rejected; data requests cannot grant access.

Protected configuration currently pins the pilot resource and issuer URLs; this
is not yet a generic one-command installation. Personal memory is explicitly
enabled with `CONTEXT_PERSONAL_MEMORY=enabled` and matching read/write grants for
`private:personal`. That fixed existing protocol scope is not the new owner-defined
area model. Local no-auth MCP is an explicit loopback-only synthetic test mode,
rejected for production/private use.

## Sources and retrieval

Sources, material metadata, original text-file bytes, checksums and retry identity
are stored in SQLite. Capture is transactional and preserves input before optional
interpretation. Today's capture does **not** implement the approved secret-redaction
pipeline or hard-delete contract; do not infer those protections from the target spec.

The primary protected personal tools are:

| Tool | Current behavior |
| --- | --- |
| `remember` | Saves text and optional metadata in the fixed personal inbox, records authenticated-client origin and returns stable identity on unchanged retries. Does not enqueue processing. |
| `memory_context` | Pages originals by source date (capture date if absent), with optional any-keyword FTS, continuation and explicit oversized-source reporting. |
| `context_package` | Returns bounded lexical/timeline evidence from originals and stored knowledge, with excerpts, provenance, status and at most one hop of stored relations. |
| `read_material` / `read_knowledge` | Retrieves a referenced original or derived item under fresh authorization checks. |

Clients supply explicit date boundaries and inspect coverage/truncation. A package
is not an exhaustive archive scan; paged original retrieval handles full periods.
Current FTS has no Russian/English morphological pipeline or semantic embeddings.
Derived knowledge is source-grounded but is not yet the approved automatically
maintained understanding layer with deduplication and superseding.

## Processing and legacy interfaces

A durable processing queue supports leases, retries and replay of saved validated
output. An operator-launched local Codex CLI extraction path exists for synthetic
experiments. The runtime image contains neither Codex nor subscription credentials;
unattended hosted processing and its credential lifecycle remain unverified.
Capture and retrieval do not require an inference provider.

Ed25519 owner-review receipts, work evidence (`work_context`, GitHub evidence),
synthetic scopes and `project_context` still exist in code. Stage 1a removes these
experiments and obsolete dependencies while preserving retained memory and access
checks. Synthetic test data remains required after that removal. GitHub PR import
in stage 2 is a separate source-ingestion feature.

## Recovery and transition

SQLite online backup and offline restore commands exist; they include sources,
derived records, jobs, indexes and retry state. Automated nightly off-host delivery
is not implemented. See [deployment](deployment.md) for current commands and limits.

Stage 1b replaces Keycloak and its PostgreSQL DB with core OAuth 2.1 AS, DCR, PKCE,
password + WebAuthn passkey login and CLI tokens; existing ChatGPT/Codex connections
must reconnect. Later stages add imports/evals, morphology/local embeddings,
pluggable understanding and owner controls. An inferred topic never grants area
access. Consult the [glossary](../CONTEXT.md) when naming these new concepts.
