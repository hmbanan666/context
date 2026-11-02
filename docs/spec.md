# Context product spec

Owner-approved direction: **Nick, 2 November 2026**. This spec supersedes older
README/roadmap direction and development-stop statements. It records the target,
not a claim that every capability is implemented. Stage 1, imports, retrieval evals and hybrid search are
merged; see architecture/roadmap for current status and live evidence. The owner's
simplicity direction preserves existing built-in OAuth connections during cleanup.

Use the [glossary](../CONTEXT.md) for product language and the [ADRs](adr/) for
accepted decisions. [Architecture](architecture.md) and [deployment](deployment.md)
describe the current implementation and operational limits.

## Problem statement

Personal context is scattered across conversations, coding sessions and project
records. Changing an AI client loses continuity; literal archive search misses
meaning, and manual tagging, repeated login and per-record signing make memory
cost more effort than it saves. The owner needs trustworthy answers grounded in
preserved sources, with control over what each agent can read or change.

## Solution and users

One owner runs an MIT open-source personal context engine on their own server.
The target is one `docker run` command and a black box after setup: capture,
processing, sorting and backups run automatically. MCP is the common interface
for authorized agents; changing Claude to OpenAI or another provider must not
change ownership, stored context or access rights.

The users are the **owner** and their **clients**. A client has rights delegated
by the owner, not a separate tenancy. The owner web UI lives in the core and
covers search, inbox decisions, delete and clients/tokens. All of those actions
are also possible through authorized agents via MCP.

## User stories and journeys

1. As the owner, I want to connect a standard MCP OAuth client, so that setup
   does not require operating an identity platform. The client discovers the
   built-in server, registers through DCR and uses authorization-code PKCE. I
   log in with password + passkey (WebAuthn), with no separate MFA, and approve
   its rights and default write area. Registration alone grants no memory access.
2. As the owner, I want to connect a headless agent, so that it can work without
   a browser login. `context token create <client> --scope ...` issues a bearer
   token with bounded rights. The client appears in the same revocable client list.
3. As the owner, I want to say "remember this", so that capture needs no technical
   choices. The client uses its default write area or an explicitly allowed area;
   unknown routing goes to inbox when authorized. Secrets are redacted before
   storage, then the source and provenance are saved before processing. The reply
   distinguishes saved, failed and retryable; unchanged retries do not duplicate it.
4. As the owner, I want to ask from a fresh or different client, so that my memory
   survives provider changes. The client reads the understanding layer first,
   verifies claims against raw sources and cites them. It distinguishes current
   facts, superseded history, proposals and approved decisions, and reports gaps.
5. As the owner, I want to reopen a client after inactivity, so that ordinary use
   does not demand repeated setup. Valid authorization refreshes normally;
   revoked or expired authorization gives an honest reconnect result, not data access.
6. As the owner, I want to import existing archives before relying on new writes,
   so that my earlier context is useful. Grok Bot transcripts, Codex sessions and
   GitHub PRs are first; ChatGPT export and Telegram come later. Each import maps
   the source bot/repository to an area, preserves provenance and reports per-item
   results; retrying an interrupted import does not create duplicates.
7. As the owner, I want uncertain inbox items presented for one-click decisions,
   so that daily server sorting handles routine routing and I resolve ambiguity.
   A routing decision uses my area policy, not an inferred topic as permission.
   Agents can perform the authorized decision through MCP before the full UI ships.
8. As the owner, I want to hard delete a record, so that it and all derived items
   disappear from retrieval, history and processing. The journal retains only a
   "deleted by owner" tombstone, not the content or a summary of it.
9. As the owner, I want to inspect clients and revoke a client or token, so that
   it loses access without deleting my memory or affecting unrelated clients.
10. As the owner, I want to restore from an off-host backup after losing the host,
    so that sources, provenance and access policy survive. Recovery validates the
    copy and requires no inference provider to read saved sources; it must account
    for subsequent owner deletions and revoked credentials before reopening access.

## Requirements and implementation decisions

### Ownership and access

- One owner per instance; MIT licensing remains in place. One-command startup
  replaces the multi-service identity setup. Initial setup configures the owner,
  client rights, processing choice and backup target; ongoing routine work is automatic.
- Build OAuth 2.1 AS, DCR, PKCE, password + WebAuthn passkey login, CLI bearer
  tokens and revocable client rights into the core. Remove Keycloak and its
  PostgreSQL database in stage 1b. That historical issuer switch required reconnecting. Subsequent simplification
  preserves built-in client/token formats and public URLs, requiring no reconnect.
- Support any conforming authorized MCP agent. Demonstrate interoperability with
  ChatGPT, Claude and Cursor, and the server Codex/headless token path; listing
  tools alone is insufficient evidence of save/reopen/ask behavior.
- The owner defines areas (for example personal, finance and infra). Each client
  has allowed read areas, allowed write areas and a default write area within its
  write rights. Use “scope” only for OAuth or existing protocol/CLI field names.
- Imports map the source bot/repository to an area. An explicit unauthorized area
  is rejected; an unknown destination falls back to inbox only with inbox write
  permission. Default routing is not a grant. Read/write checks cover originals,
  derived items, search results, counts, provenance and follow-up reads.
- Daily inbox sorting follows owner-authorized routing/disclosure policy. Model
  output cannot widen rights or disclose data by moving it to a broader area.
  Uncertain destinations or disclosure require an owner decision. Area is not topic.
- Consequential actions, destructive owner operations and external disclosure
  require the appropriate owner authorization; ordinary authorized capture and
  retrieval need no per-record signature or review receipt.

### Sources, understanding and ingestion

- Redact tokens, keys and passwords before any durable source, import staging,
  job payload or log stores the input. The retained raw source is the redacted
  original; do not keep an unredacted shadow copy. Preserve its provenance and
  authored/capture timestamps, and identify redaction without retaining the secret.
- Persist immutable sources before interpretation. Validation, size limits,
  idempotency and safe retries apply to both MCP writes and imports. A processor
  outage must not prevent capture or exact retrieval of already saved sources.
- Derive facts about the owner, decisions, projects and people with source links
  and status. Clients consult this understanding layer first, then raw evidence;
  before it is available they can retrieve originals and report that limitation.
- Deduplicate derived knowledge without destroying distinct source provenance.
  Superseding changes the current fact and retains older facts in history; it
  never rewrites the raw source or promotes a proposal to owner approval.
- Hard delete removes the selected record and all derived items, including
  history, search representations and queued/cached processing outputs that could
  recreate it. Leave only the minimal deletion tombstone in the journal. Define
  backup retention and restore reconciliation before claiming complete deletion;
  an old copy must not silently reintroduce deleted content into active memory.
- Begin ingestion with Grok Bot, Codex sessions and GitHub PR imports alongside
  agent MCP writes. A PR is source material, not a signed work-evidence workflow.

### Search and processing

- Keep SQLite. Add Russian and English morphology to FTS and semantic search
  using a small local embedding model on the server, without a paid embedding API.
  Keep indexes derived, rebuildable and subject to the same area access rules.
- Make the understanding processor pluggable. Default options use the owner's
  subscription/API: Codex CLI on a ChatGPT plan or an OpenAI/Anthropic API key.
  A local LLM is a fallback option. Verify supported execution and credential
  lifecycles; never silently switch to paid API use or circumvent subscription terms.
- Switching processors preserves sources, provenance, history and client rights.
  Failures are visible and retryable without duplicate derived items. The processor
  and local embedding model serve different purposes and can change independently.

### Quality, operations and owner controls

- Keep 20–30 real evaluation questions, source material, expected answers and
  outputs private, outside this public repo. Commit only synthetic equivalents.
  Run evals after each change and nightly; public CI runs the synthetic set,
  while the private set runs in an owner-controlled environment.
- Track grounded answer quality, relevant source coverage, incorrect claims and
  access isolation against a recorded baseline. Report regressions and unrun checks.
- Nightly backup includes a configurable off-host copy over SFTP or S3-compatible
  storage. Report snapshot and delivery status independently, retry safely and
  verify restoration from that copy. Backups are plain SQLite over SSH/TLS;
  client-side encryption is explicitly out of scope. Contents and credentials remain private.
- Provide core owner UI for search, inbox decisions, deletion and clients/tokens,
  with corresponding authorized MCP operations. Owner login needed by stage 1b
  precedes the full management UI in stage 5.

## Testing decisions

Test external behavior at the MCP, authorization/CLI and backup/restore interfaces;
exercise the owner UI when it arrives. Prefer existing protected MCP and restart/
restore integration patterns, with client-visible results rather than internal
schema assertions as acceptance. Existing lexical retrieval comparisons supply
a baseline, not proof of semantic search or understanding-layer quality.

Use synthetic fixtures for retries, restart, cross-client retrieval, area denial,
secret redaction, superseding and deletion. For imports, repeat an interrupted
batch and verify source identity and provenance. For search, compare inflections
and paraphrases in both languages against the same frozen corpus and questions.
For processing, fail or change the provider and verify source availability and
safe retries. For recovery, restore an off-host copy into an isolated instance
and exercise authorized reads, denied reads and deletion/revocation reconciliation.

Record the tested commit and separate automated evidence from actual-client
acceptance. Actual OAuth client checks include save/read/retry, natural access
expiry, forty-minute inactivity and next-day use without needless reauthorization,
then revocation. Fixture tokens and discovery alone cannot close those journeys.
Private eval evidence remains private; public summaries contain only safe aggregates.

## Stages and acceptance criteria

Stages describe the approved sequence. Each implementation is a small, testable
PR; every merge and deployment still needs separate explicit owner approval.

### Stage 1 — Cleanup and self-contained operation (merged; live acceptance tracked separately)

**1a — Remove experiments (one PR-sized slice).** Remove Ed25519 owner signatures/
review receipts, work evidence including `work_context` and GitHub evidence,
synthetic scopes and `project_context`. Remove obsolete interfaces and dependencies
without disabling authorization on retained memory operations. Preserve needed
sources and provenance during migration; historical code remains in Git.

Acceptance: removed tools are absent; no retained memory path requires signatures;
synthetic fixture tests still demonstrate save/read/retry, restart and denied
access. Replace experimental scope assumptions with the area policy needed by
retained operations. Removing synthetic scopes does not remove synthetic-only
fixtures. Keycloak remains until 1b.

**1b — Built-in authorization (one PR-sized slice).** Replace Keycloak and its
PostgreSQL DB with OAuth 2.1 AS, DCR, PKCE, password + WebAuthn passkey login and
CLI tokens. Persist clients, rights and default write areas; expose authorized
client/token management through MCP and the CLI as needed before the full UI.

Acceptance: the standalone core starts with one documented `docker run` command
and persistent storage, without identity services. A standard MCP OAuth client
registers and connects after owner authorization; test ChatGPT/Claude/Cursor
compatibility and Codex access, scope denial, invalid credentials, refresh and
revocation. Existing ChatGPT/Codex connections reconnect to the new issuer and
retain only approved rights; migrated sources remain readable. CLI-issued tokens
support bounded headless access and revocation. Record actual-client inactivity
checks separately from protocol tests. No separate MFA is required.

**1c — Nightly backup (one PR-sized slice).** Schedule nightly snapshots and
copy them to an owner-configurable SFTP or S3-compatible target.

Acceptance: both target types pass isolated synthetic delivery/restore checks;
a scheduled run produces a complete off-host recovery copy. Failed snapshots
or transfers report failure and can retry without losing the last usable copy.
Restore into an isolated instance preserves sources, provenance and access
policy. Document target setup, retention and recovery; expose the last success
and failures without leaking credentials or records.

### Stage 2 — Clients, imports and eval set (in progress)

Connect Grok Bot and server Codex as clients. Import Grok Bot transcripts, Codex
sessions and GitHub PRs. Establish the 20–30-question private eval set and public
synthetic equivalents; run after each change from this stage onward.

Acceptance: both clients save and reopen the same authorized synthetic source;
foreign-area reads/writes fail. Each importer preserves source identity,
provenance and configured area mapping; unknown routing safely enters inbox,
and interrupted reruns do not duplicate records. Secrets are redacted before
storage. The private baseline stays private; public CI runs synthetic equivalents
and records baseline quality and known misses. Nightly eval automation follows
in stage 4, not a claim about the current CI.

### Stage 3 — Morphology and local semantic search (merged; live acceptance tracked separately)

Add Russian/English morphological FTS and small local-model embeddings on the
server, retaining SQLite.

Acceptance: frozen inflection/paraphrase cases in both languages improve against
the stage 2 baseline, with citations and no cross-area disclosure. Report quality
regressions, latency and resource use. Embedding generation makes no paid API
calls; exact source retrieval remains usable while its index rebuilds.

### Stage 4 — Understanding, consolidation and nightly evals (planned)

Build facts, decisions, projects and people from saved sources through the
pluggable processor. Add deduplication, superseding/history, hard delete with
tombstones, daily inbox sorting and uncertain-item decisions via MCP. Automate
nightly evaluation as well as the existing after-change runs.

Acceptance: answers start with derived knowledge and verify against accessible
sources; evals show grounded benefit over the retrieval baseline. Changing or
failing the processor leaves sources intact and retries safe. Demonstrate a
supported subscription/API path and local LLM option; mark any unavailable path
unverified. A new fact supersedes the old current fact without losing history;
proposals never become owner approval by inference. Daily sorting respects area
policy and ambiguous items await owner decisions. Hard delete removes the record
and derivations from reads, search, history and pending processing; only the
tombstone remains. Test that restore reconciliation prevents silent resurrection,
with an explicit backup-retention contract. Private and synthetic nightly evals
report failures without exposing private questions or results publicly.

### Stage 5 — Owner UI and more imports (planned)

Add the core owner UI for search, one-click inbox decisions, delete and clients/
tokens, plus ChatGPT export import and Telegram ingestion.

Acceptance: the owner completes each UI journey with the same authorization and
results as MCP, including after inactivity. Both new ingestion paths preserve
redacted sources, provenance, area mapping and retry identity. Recheck the full
connect/remember/ask/import/decide/delete/revoke/restore journey and publish only
synthetic evidence and safe aggregate outcomes.

## Non-goals

Multi-tenancy, a general messenger, an agent launcher/orchestrator, task dispatch
or deployment automation, signed work-evidence tracking, a separate identity
platform, a graph visualization product, and paid embedding APIs are outside
this direction. A public real-memory dataset is never a deliverable. The owner
UI and optional paid processor API are in scope; they are not legacy exclusions.

## Further notes

Implementation must choose the local embedding model, processor runtime details,
passkey recovery procedure and backup/deletion retention policy, and record their
observable behavior in the relevant slice. Those details are not claims of
already approved implementations. This PR requests review of the recorded
product direction; it does not authorize merge, deployment or live-data access.
