# Current architecture

Context is a single Node/TypeScript process serving MCP Streamable HTTP at `/mcp`,
built-in OAuth and `/health`, backed by SQLite. One non-root container and one data
volume suffice; a separate backup volume remains supported for existing installs.
The [spec](spec.md) and [ADRs](adr/) describe the target beyond today's behavior.

As of 2 November 2026, cleanup, built-in auth, nightly backups, JSONL imports,
retrieval evals and hybrid search are merged. The owner reports ChatGPT connected
live and confirms eval #27 and hybrid search #28 are deployed. This is owner-
reported status; the simplicity refactor has not accessed production.

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

MCP discovery lists only `search`, `remember`, `read` and `timeline`.
`mcp-surface.ts` registers these thin adapters and overrides only `tools/list`;
the SDK still validates and dispatches every old name through `tools/call` with
its original schema and access checks. Existing text `remember` calls retain
client provenance and retry identity; an optional file input uses the same file
writer/redaction as `capture_file`. Grounded suggestions remain a distinct legacy
write (`add_knowledge`). No storage or credential migration is required.

`search` maps query/k/date inputs to the existing context package and points
follow-up reads to `read`. `read` returns originals, file bytes or knowledge plus
bounded incident relations in the authorized area. `timeline` uses the existing
bounded source timeline, newest first by creation date else capture date; derived
suggestions are not separate source events. See the [tool table](../README.md#mcp-tools).
`memory.ts` pages original evidence; `context-package.ts` builds bounded evidence
from sources/knowledge and one-hop relations. Both enforce area restrictions.
Search combines exact and RU/EN stemmed FTS with local E5 embeddings. The image
includes the model; startup and writes backfill derived vectors in the background,
with lexical fallback on model failure. Area/date filters precede fusion.
See [search](search.md) for bounds, rebuild and measured resources. Relation-aware retrieval collapses duplicates and ranks superseded history last.

`knowledge.ts` stores source-grounded suggestions and relations, redacting their
text/provenance before persistence. Historical review rows remain readable; there
is no review/signature writer. Old experimental tables may remain unused in an
existing database; no startup cleanup drops or rewrites them.

## Retrieval measurement

The [eval harness](evals.md) exercises the protected `context_package` handler
with simulated read-only client grants over an in-process MCP transport. Search
remains owned by the MCP implementation, with its embedding index attached.
Nightly eval shares the server index/model; the standalone CLI opens a read-only
index and loads one local model. History records actual semantic availability
and a lexical-control comparison. Source and knowledge stores have explicit
read-only opening modes; a separate metadata lookup audits the actual area of
returned sources, items and relations. Results contain content-free metrics, search metadata and
question IDs, appended to `evals/history.jsonl` beside the database.

The nightly callback runs backup → tidy → eval (if `evals/questions.yaml` exists).
A backup failure still permits tidy/eval; a busy backup defers the callback. There
is no independent timer. Eval can assert expected evidence `outranks` history;
results retain only a per-question boolean, not matching text.

## Processing and recovery

`tidy.ts` processes each area independently: deterministic exact/vector dedup,
optional model superseding, then confident inbox sorting. `knowledge_relations`
accepts source or knowledge endpoints, with `duplicates` added by a transactional
CHECK/FK table migration preserving historical rows and retry keys. Both endpoints
and evidence must share the relation's area. A supersedes B means A is current;
A duplicates B means B is canonical. Sources and their text/checksums remain intact.

`llm.ts` is a bounded, provider-agnostic fetch client shared by tidy and the
operator-run `memory:process` command. The version-pinned Codex adapter is removed.
`jobs.ts` still owns explicit processing leases and durable validated output.
No key means dedup only; no inference provider is needed for capture or reading.
Tidy history is content-free JSONL beside eval history, including the successful
watermark, model, counts and duration. Distilled per-topic knowledge and hard
delete are future slices, not claims of complete stage 4 acceptance.

Inbox moves are transactional metadata changes. FTS/stemmed rows retain their
rowids/text and enforce area by joining sources; embedding scopes move and active
embedding leases are invalidated. Sources with knowledge, relations (including
provenance references), or processing jobs stay in inbox. Existing client/token
read grants must not gain access through the destination. Historical capture and
import request identities remain reserved: former-area retries fail closed rather
than revealing the moved source or recreating a copy. Import/file metadata is
source-ID keyed and follows the source without rewriting content.

Backups run in-process. The scheduler handles calendar dates; the runner verifies
snapshots, coordinates CLI/scheduled locking and retains local files; transports
stream optional S3/SFTP copies. These boundaries support actual failure/restore
checks and are retained. All ten runtime dependencies serve active MCP, WebAuthn,
validation, search, eval or backup paths; none is removed merely to reduce the count.

[Recovery](deployment.md#backups) includes the complete SQLite state and preserves
rights/retry identity. Off-host recovery and live save/reopen/ask require separate
operational evidence. No merge or deployment is implied by passing local tests.
