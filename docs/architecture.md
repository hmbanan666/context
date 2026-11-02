# Current architecture

Context is a single Node/TypeScript process serving MCP Streamable HTTP at `/mcp`,
built-in OAuth and `/health`, backed by SQLite. One non-root container and one data
volume suffice; a separate backup volume remains supported for existing installs.
The [spec](spec.md) and [ADRs](adr/) describe the target beyond today's behavior.

As of 2 November 2026, cleanup, built-in auth, nightly backups, JSONL imports,
retrieval evals and hybrid search are merged. The owner reports ChatGPT connected
live. Repository implementation and live deployment remain distinct states.

## Access

The core is both authorization and resource server: DCR, S256 PKCE, owner password
and WebAuthn passkey login, bounded consent, CLI tokens and immediate revocation.
The public MCP URL is the exact audience; its origin is the issuer. OAuth and CLI
credentials use random opaque values with only hashes persisted. Each MCP call
checks credential scopes and area/operation pairs intersected with the current
client registry. There is no owner-configured static-grants registry. The read-only
eval harness supplies simulated grants in-process, without a network listener.

`auth-store.ts` owns the unchanged auth tables and credential lifecycle;
`oauth.ts` and `passkeys.ts` handle protocol/browser flows; `auth.ts` protects MCP.
Owner sessions are bounded, Secure/HttpOnly/SameSite=Lax, CSRF/Origin checked.
Resource URLs and client/token storage formats remain stable in this refactor.
See [deployment](deployment.md#authentication) for expiry and recovery details.

Areas are independent of topics. `CONTEXT_AREAS` defines up to eight; wire fields
remain `scope`. `remember` defaults to the credential's write area, which grants
no extra rights. Loopback no-auth mode is explicit and forbidden in production.

## Sources and retrieval

`store.ts` stores sources, metadata, text-file bytes, checksums and retry identity
transactionally. `redaction.ts` provides the shared deterministic filter for MCP,
imports and collectors. All content/provenance strings are redacted before
checksums, fingerprints, FTS or durable writes; decoded file bytes receive the
same filter. Invalid redacted identities are rejected. Existing sources are not
rewritten. Pattern matching cannot identify every unlabeled secret.

[Imports](imports.md) stream bounded JSONL, preserve attribution in `source_imports`
and retain changed external items as immutable revisions. Source and import
identity commit together. Unchanged revisions skip safely on retries.

The recommended MCP journey is `remember`, `context_package`, `read_material`.
All 15 wire names remain: explicit-origin capture wrappers share store writers;
legacy retrieval keeps exact-ID, phrase and cursor contracts. The
[README tool table](../README.md#mcp-tools) lists the complete interface.
`memory.ts` pages original evidence; `context-package.ts` builds bounded evidence
from sources/knowledge and one-hop relations. Both enforce area restrictions.
Search combines exact and RU/EN stemmed FTS with local E5 embeddings. The image
includes the model; startup and writes backfill derived vectors in the background,
with lexical fallback on model failure. Area/date filters precede fusion.
See [search](search.md) for bounds, rebuild and measured resources. This refactor
preserves those search internals.

`knowledge.ts` stores source-grounded suggestions and relations, redacting their
text/provenance before persistence. Historical review rows remain readable; there
is no review/signature writer. Old experimental tables may remain unused in an
existing database; no startup cleanup drops or rewrites them.

## Retrieval measurement

The [eval harness](evals.md) exercises the protected `context_package` handler
with simulated read-only client grants over an in-process MCP transport. Search
remains owned by the MCP implementation. Source and knowledge stores have explicit
read-only opening modes; a separate metadata lookup audits the actual area of
returned sources, items and relations. Results contain only numeric metrics and
question IDs, appended to `evals/history.jsonl` beside the database.

The existing nightly backup callback runs eval afterward if `evals/questions.yaml`
exists. No independent timer, settings, worker or job store is added. This delivers
retrieval measurement and that narrow automation step; it does not claim private
question-set acceptance, answer grading or the remaining stage 4 capabilities.

## Processing and recovery

`jobs.ts` retains processing leases, retries and durable validated/redacted output.
`processor.ts` coordinates interpretation after source capture. The optional
operator-run `memory:process` command uses the existing restricted Codex adapter;
the runtime image has no Codex installation or subscription credentials. Unattended
understanding, sorting, superseding and hard delete remain future work. Capture
and source retrieval need no model.

Backups run in-process. The scheduler handles calendar dates; the runner verifies
snapshots, coordinates CLI/scheduled locking and retains local files; transports
stream optional S3/SFTP copies. These boundaries support actual failure/restore
checks and are retained. All ten runtime dependencies serve active MCP, WebAuthn,
validation, search, eval or backup paths; none is removed merely to reduce the count.

[Recovery](deployment.md#backups) includes the complete SQLite state and preserves
rights/retry identity. Off-host recovery and live save/reopen/ask require separate
operational evidence. No merge or deployment is implied by passing local tests.
