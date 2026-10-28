# Experimental roadmap

## Current milestone — personal text pilot, approved 28 October 2026

The owner approved implementation and necessary rule corrections. This
supersedes historical development-stop statements and the prior proposal-only
status for this bounded outcome. It does not authorize automatic future
milestones; release approval remains separate under AGENTS.md.

**Outcome:** save selected personal notes through ChatGPT without technical
classification or signatures, reopen the connection on another day, and obtain
grounded context for a period or chapter through a fresh authorized client.

**Implementation:** an explicitly protected personal inbox, scope-free
`remember`, and pageable `memory_context` over original sources and dates.
Existing originals, grants and signature checks remain intact. Client-side
synthesis is sufficient for the first pilot; extraction's value remains an
unproved hypothesis. No paid API, hosted worker, Telegram/audio or new UI is
part of this slice.

**Acceptance:**

1. Protected synthetic capture, exact reread, retries, unauthorized denial,
   period coverage beyond twenty notes, and restart/restore pass.
2. The approved release is activated with explicit personal grants while
   retaining existing synthetic access and data. Original recovery is verified.
3. The actual ChatGPT connection requests its intended consent, saves and reads
   sequentially after access expiry, after idle time, and on the next day,
   without another login. A second authorized client reads the same source.
4. Only after those activation checks, the owner-selected real notes can enter
   private storage. Public tests, PRs and logs contain only synthetic fixtures.

Report each state independently. If the client's refresh remains broken,
diagnose the actual request/grant before changing token lifetimes or repeating
logins. Telegram and voice are the next candidate only after text use succeeds.

## Historical planning and evidence

**Planning snapshot:** 27 October 2026  
**Status:** Sprints 0 and 1 merged in PRs #2 and #3. Sprint 2 implementation
merged in PR #4 and deployed with separate owner approval. Hosted TLS/OAuth,
actual Codex CLI login, SDK persistence and recovery checks passed. The owner
confirmed the actual ChatGPT-to-Codex roundtrip; connected Codex recall was
independently observed. Its separately approved live container recreation and
isolated offline restore passed, closing Sprint 2 synthetic acceptance.
The owner explicitly authorized Sprint 3 implementation on 27 October 2026.
Its four reviewed/tested slices were merged in PRs #6–#9 after separate owner
approval. Hosted synthetic release acceptance passed for `ff9fd9a`, closing
Sprint 3; the separately approved Codex refresh compatibility fix is PR #10.
Sprint 4 implementation was separately authorized and merged in
[PR #12](https://github.com/hmbanan666/context/pull/12) as `d2c570a` on
27 October 2026. Its release record reports Context `0.4.0` deployed with
protected hosted checks. Human-confirmation end-to-end acceptance remains
unverified. The owner stopped manual key/JSON signing and technical development
to evaluate the core's usefulness. No new sprint or UI is authorized.
Any further merge or deployment requires separate approval.

Sprint 3 review stack:
[source materials #6](https://github.com/hmbanan666/context/pull/6),
[structured knowledge #7](https://github.com/hmbanan666/context/pull/7),
[subscription processing #8](https://github.com/hmbanan666/context/pull/8),
[project context/access #9](https://github.com/hmbanan666/context/pull/9).

## North-star acceptance

A person can deliberately save a thought from ChatGPT, retrieve its authorized
context through a new Codex session, and eventually trace an approved action
to PR/CI/merge/live evidence without rewriting history.

## Sprint 0 — Local foundation

**Outcome:** Runnable TypeScript service and repeatable tests without cloud
accounts, paid LLM APIs, or private data.

- Pin Node and package manager, implement minimal server entry point.
- Add SQLite test persistence, deterministic fixtures, lint/type/test and CI.
- Document exact local commands and environment variables.

**Acceptance:** clean checkout can run documented commands; restart/persistence
smoke test passes; test data is synthetic.

**Stop gate:** Review code and test environment before adding remote access.

## Sprint 1 — MCP capture and recall

**Outcome:** A local MCP client can store a source and retrieve it later.

- Use official MCP SDK with Streamable HTTP.
- Implement `capture`, `recall`, stable ID, provenance, scopes, timestamp,
  checksum, validation and idempotency.
- Implement scoped exact lookup and simple SQLite full-text search.
- Run MCP Inspector and integration tests for duplicates, invalid inputs,
  forbidden scope, restart and data integrity.

**Acceptance:** a fresh local client reads precisely the same record after
restart; unauthorized reads are denied; no inferred user approval.

**Stop gate:** Do not add Mastra, graph visualization, embeddings or agents.

## Sprint 2 — Protected Context in Dokploy and plugin interoperability

**Outcome:** A hosted private Context instance accepts authenticated ChatGPT
and Codex requests with scoped access.

- Package Docker runtime and persistent storage; provide health checks,
  backup/restore procedure and privacy-preserving logs.
- Deploy as a separate Dokploy app, using an owner-approved HTTPS domain.
  Never use the Dokploy admin hostname as the MCP endpoint.
- Select and verify compatible OAuth 2.1 authorization; test token scope,
  missing/expired token, refresh behavior and audience validation.
- In ChatGPT Plugins connect **Context**, not Dokploy. Confirm the actual
  `capture` write tool works under the owner's account.
- In a fresh Codex MCP session, read the same **synthetic** test record.
- Prove restart/redeploy persistence and unauthorized access rejection.

**Acceptance:** real ChatGPT-to-Context-to-Codex synthetic-data roundtrip
is demonstrated and documented; protected data is never anonymously
accessible. Report explicit blockers if auth or plugin write is unavailable.

**Stop gate:** No real private-memory ingestion until owner authorizes it.
No merge or live deploy without separate owner permission.

## Sprint 3 — Structured knowledge and source processing

**Outcome:** Ingest files and derive reviewable knowledge with provenance.

- **Sources:** immutable metadata and original UTF-8 `.txt`/`.md` bytes, atomic
  capture/retries, backward-compatible migration, complete backup/restore.
- **Knowledge:** suggested ideas, observations and decision proposals, grounded
  relations, signed owner review and append-only evidence/history.
- **Subscription feasibility:** actual local ChatGPT-authenticated extraction
  passed with the probed Codex CLI; a real queued source produced two grounded
  suggestions without changing the original. Hosted execution, refresh and
  sustained quota behavior remain unverified.
- **Processing:** persistent scoped queue, exclusive leases, bounded attempts,
  saved validated output and idempotent recovery after partial derived writes.
- **Project context:** independent read/write/process grants for existing
  clients, complete scoped provenance and bounded UTF-8 context packages.
  This limited projection capability moves here from Sprint 4 by owner request.

Files are deliberately bounded to one text family and 16 KiB. Audio, images,
PDF parsing, URL fetching, hosted unattended model execution and real private
ingestion are not demonstrated by this slice. Evaluate RAG/vectors or Mastra
only after retrieval benchmarks justify them.

**Acceptance:** no data loss on failed processing; inferred facts and human
decisions are distinct; all derived links cite original sources.

**Observed local evidence:** full regression tests, actual subscription job,
independent storage/access review, non-root container restart/restore, and
real disposable Keycloak project-token tests. PR review, merge, deployment and
hosted acceptance remain distinct states. Do not label the sprint shipped solely
because its local tests pass.

**Observed hosted evidence:** all 14 tools exercised through real owner OAuth;
source/material/knowledge/relation/context/queue checks; A access and B denial
despite a signed B scope; exact queued-job snapshot/restore; unchanged original
ChatGPT source/retry; new-process automatic OAuth refresh after more than five
minutes without another login. Sprint 3 synthetic acceptance is closed on this
combined evidence. Unattended hosted model execution, real private ingestion,
owner signing-key provisioning and whole-host-loss recovery remain separate.

## Sprint 4 — Idea to verified work

**Outcome:** Link an approved intent to GitHub scope and an actual result.

- Use the scoped Sprint 3 context to propose an explicitly approved sprint.
- Require human approval for task dispatch and disclosure decisions.
- Fetch GitHub state independently; record PR, check results, merge and
  deployed evidence as distinct facts.
- Verify Codex can consume a context package without full personal history.

**Acceptance:** fresh planner retrieves why the task exists and what really
shipped, backed by original sources and GitHub evidence; failed or unmerged
PR does not count as completed.

**Implementation boundary:** one existing signed approved decision, a separate
signed dispatch/disclosure permission bound to public repository/branches,
operator-only GitHub reads, append-only observations and one scoped read-only
`work_context` package. No agent launcher, GitHub writes, scheduler, new tracker,
merge or deployment automation. Old merged PRs are historical facts, not results
of a newly authorized intention. Deployment stays unverified without independent
live revision evidence. Synthetic signing tests cannot substitute for actual
owner-key provisioning, human permission or hosted acceptance.

**Final disposition — 27 October 2026:** Sprint 4 is technically implemented
and deployed. A real synthetic source and grounded suggested decision were
persisted and reread with stable checksums and retry identity. The owner then
stopped manual Ed25519 signing as unsuitable for the Personal Context Engine's
user experience. No real signed approval, dispatch/disclosure authorization or
new acceptance PR was created. The complete human-confirmation-to-result chain
remains unverified; fixture signatures and historical PRs cannot close it.

**Product conclusion:** ordinary memory should operate autonomously within its
authorized scope, without manual keys, JSON or per-record signatures. Actions
with consequences require simple user confirmation through a trusted
authenticated environment. This is a product requirement, not an implemented
replacement for the current signature boundary. Existing protections remain;
no bypass, new UI or new sprint is authorized. Technical development stops
while the owner evaluates the usefulness of the existing core. See the
[acceptance report](deployment.md#sprint-4-release-and-final-acceptance).

**Observed branch evidence:** `npm run check` passed 79 tests; the Docker build,
non-root container restart/backup/restore and disposable real-Keycloak smoke
passed. New tests reject signature/scope/approval mismatches, stale approvals,
open/closed-unmerged/failed/pending/missing-check PRs, retrospective completion,
mixed/incomplete GitHub evidence and oversized partial context. Restore retains
the work history and retry identity; repeated large observations retain a usable
latest package. A new MCP client read the same complete chain through two real
service processes. A fresh Codex planner consumed only an exported synthetic
package and correctly distinguished its source, two permissions, actual merge/CI
facts, retrospective linkage and unknown deployment. The public PR #10 probe
confirmed head `1f3d770`, merge `18f4898`, passing `check` and unchanged originals/
retries, while reporting `pr_predates_authorization`, not completed work. This
is local protocol evidence with ephemeral synthetic keys, not human approval or
a deployed Sprint 4 result.

## Post-core product validation — findings and candidate experiments

**Assessment date:** 27 October 2026. **Status:** findings recorded;
follow-up work is **proposed, not authorized**. This section does not open a
Sprint 5, authorize implementation, or supersede the completed Sprint 0–4
history. Keep actual code, reviewed PRs, merges and deployment evidence distinct.

### What the six-month synthetic experiment established

A local isolated database received 60 fictional notes dated over six months:
50 in synthetic scope A and 10 in scope B. Source text, author-supplied dates,
checksums and idempotent retries were preserved. No manual tags, knowledge or
relations were supplied. The restricted local subscription worker completed all
60 jobs, deriving **90 suggested knowledge items** (29 ideas, 40 observations,
21 decision proposals) and **zero stored relations**. No item became an
owner-approved decision.

Two fresh read-only answering sessions received the same 12 questions, before
and after extraction. A separate evaluator applied the withheld oracle only
after both answers were frozen:

| Metric | Before extraction | After extraction |
| --- | --- | --- |
| Complete grounded answers | 10/12 | 10/12 |
| Partial grounded answers | 2/12 | 2/12 |
| MCP calls | 53 | 53 |
| Unique sources retrieved | 43 | 41 |

The retrieval result passed the predeclared threshold of nine complete answers
but **showed no improvement attributable to the worker** in this paired test.
Q08 improved while Q07 regressed from complete to partial; Q04 remained partial.
Exact whole-question phrase searches yielded 0/12 matches; the answering client
used shorter literal queries and did the thematic synthesis itself. The worker
read one source at a time without authored dates, and extracted knowledge was
not indexed for recall. The existing project_context response can be
truncated; this was not an exhaustive semantic retrieval benchmark.

Integrity, exact source quotations, retry stability, local restart/restore and
scope A/B isolation passed in the supplied report. No observed B disclosure,
invented owner approval or unsupported claimed user count occurred. **Limits:**
one synthetic dataset, one answering run per phase, local CLI/MCP execution;
not a statistically established quality comparison, a real-data pilot, a
ChatGPT authorization test or proof of unattended hosted processing. The
evaluation artifacts and test database remain outside this public repository.

### Owner-approved product direction (intent, not shipped capability)

Context remains a **headless Personal Context Engine**, not a messenger,
general agent orchestrator or task tracker. The goal is to capture originals
from interchangeable inputs, preserve provenance, derive and revise useful
knowledge, and supply least-privilege context to interchangeable AI clients.

- Routine ingestion, topic discovery, grouping and interpretation should not
  require the user to choose folders, manually tag notes or approve every
  inferred item. A suggested interpretation is never owner authorization.
- **Scope is a security boundary, not a topic or project classification.**
  A note may relate to multiple projects without automatically broadening
  access to its original bytes or derived content. Safe cross-project
  summaries require explicit privacy and disclosure rules.
- The engine should remain useful without any model running: capture,
  durable storage and grounded retrieval must work independently.
- Model providers, input adapters, storage and deployment environments should
  be replaceable over time. Today's pinned Codex CLI, SQLite and
  Dokploy/Keycloak pilot are implementations, not universal requirements.
  Subscription use is optional; no silent paid-API fallback.
- Ordinary memory requires low-friction operation. Consequential actions
  require understandable owner confirmation through a trusted environment,
  not manual keys/JSON for every note. Current signing protection remains
  active until a separately reviewed replacement exists.

### Next candidate experiments — no implementation approval

**A. Capture usability and client authentication (first practical blocker).**
The user encountered repeated Keycloak password/MFA prompts in ChatGPT.
Keycloak logged inactive refresh tokens, but the precise ChatGPT refresh
failure mechanism is not yet fully proved; token duration alone is not a
diagnosis. During a parallel ten-call ChatGPT test, four synthetic writes
succeeded and six were blocked by the ChatGPT platform, not confirmed as
Context storage failures. Diagnose the actual client/provider flow and app
permissions separately. Evaluate sequential and bounded batch capture with
clear per-item acceptance, retry and conflict results; do not assume batching
bypasses platform policy. The end-user workflow must not require installing
Codex, manual key handling, or frequent reauthentication. Preserve OAuth/MFA,
authorization boundaries and revocation properties; no unapproved broad
offline grant or indiscriminate session-extension shortcut.

**B. Retrieval quality before more extraction (first memory hypothesis).**
Compare baseline literal source FTS with a narrow **derived-knowledge retrieval
candidate** on the same frozen dataset and questions. Test grounded ranking,
date filters, paraphrased queries, Q04/Q07 multi-source coverage, response
completeness and number of MCP round-trips. Run multiple independent answer
sessions, hold back the oracle, and measure both improvements and regressions.
Prototype a simple lexical index or deterministic query plan before assuming
embeddings, RAG, a graph database or another framework will help. Every result
must retain retrievable source IDs and enforce scope checks.

**C. Longitudinal memory consolidation (only if B exposes a real gap).**
Evaluate incremental topic/project suggestions, recurrence, contradiction,
supersession and changes over time across different originals. Keep authored
dates separate from ingestion dates. Consolidation may group or supersede
*derived interpretations* but must never silently overwrite originals or
treat a conversation hypothesis as owner approval. Cross-project retrieval is
a separate least-privilege design challenge, not something achieved by removing
scope checks. Measure whether this stage beats query-time synthesis.

**D. Portability and unattended processing (after core value is demonstrated).**
Assess model-provider interfaces, a simple local/no-remote mode, optional hosted
MCP auth, storage adapters and durable background processing. Keep a minimal
working installation as the reference and test cost, reliability and recovery.
Avoid rewriting currently working Keycloak or introducing a new UI/provider
solely to claim agnosticism. External integrations such as Telegram, audio,
files or browser input are candidates, not current requirements.

### Decision gates

1. Verify the actual user journey: one connection, dependable writes,
   long-lived usable access, no compulsory coding tool or per-note approvals.
2. Select **one** memory-retrieval hypothesis with a frozen baseline, a
   repeatable evaluation and meaningful success criteria: improved grounded
   coverage (especially Q04/Q07), no access/provenance regressions and fewer
   model/tool interactions when possible.
3. Only after the evidence is reviewed, explicitly approve a bounded
   implementation sprint. Do not turn all candidates into a backlog, deploy
   them automatically or create GitHub Issues just for internal tracking.

The immediate deliverable is an evidence-based **product decision**, not a
bigger architecture or a new sprint by default.

## Not in current scope

General messenger, full personal OS, autonomous issue-watcher, UI-heavy graph,
multi-tenant product, paid hosted LLM processing, unsolicited PR merges or
unattended production deployment.

## Agent delivery protocol

One approved milestone and one narrow PR at a time. Use available engineering
Skills when useful. After each, report test evidence, blockers and the next
owner decision. Do not create a new task tracker merely to manage a pilot.
