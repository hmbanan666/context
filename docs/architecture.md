# Architecture hypothesis

## Current personal text pilot

The owner approved the personal text pilot on 28 October 2026. Earlier stop
statements describe the end of Sprint 4, not a prohibition on this milestone.
The primary path is authenticated `remember` → immutable source/material →
`memory_context` → synthesis by the calling AI client. Signed decisions and
work evidence remain independent of everyday memory.

One explicitly enabled inbox, `private:personal`, is an access boundary, not a
topic. Both signed OAuth consent and configured per-client operation grants
are mandatory. It is unavailable to the local no-auth test mode and cannot be
enabled simply by changing a tool argument. Existing synthetic grants stay
separate. No automatic disclosure to a new client or project is implied.

For the existing owner-controlled ChatGPT app, its immutable OAuth request can
remain `context:read context:write context:process`. An opt-in provider profile
assigns its already approved data scopes and bounded offline access as default
client scopes. These scopes still appear in signed tokens and every read/write
still intersects them with independent server grants. Defaults do not add
operation scopes: a read-only authorization remains unable to write. This is
an explicit grant to one dedicated client, not automatic consent for every
future client or inferred topic. New memory tools within this inbox should use
the stable operation/data contract instead of requiring a new scope per feature.
The generic realm import and the Codex client stay unchanged; the profile needs
its own activation and actual-client acceptance.

The new projection is chronological and pageable over originals, with optional
any-keyword FTS. It distinguishes authored source dates from capture dates,
handles timezone offsets, pins an insertion watermark across pages, and reports
incomplete/oversized evidence. It does not invent interpretations or event dates.
The client cites the source IDs and performs the answer synthesis. Models are
not on the capture path. SQLite remains the durable original store, including
text-file BLOBs; no new storage service or filesystem mirror is needed here.

The complete tool contract is in README. Activation and actual ChatGPT
acceptance are tracked in deployment.md; tests and a merge do not establish
that the owner's connection has been upgraded or that next-day refresh works.

**Status:** Local source persistence and synthetic MCP capture/recall are
implemented (see README for the tested contract). The protected synthetic pilot
is deployed with Keycloak; hosted OAuth and actual Codex CLI login are verified.
The owner reports a completed ChatGPT write-to-Codex roundtrip; a connected Codex
tool independently retrieved that synthetic record on 27 October 2026. Its
approved live redeploy and isolated offline restore passed, closing Sprint 2
synthetic acceptance. Exact operational evidence is recorded in deployment.md.
Sprint 3 source materials, grounded knowledge, local subscription processing and
project context were reviewed, tested and merged in PRs #6–#9. Hosted synthetic
acceptance for `ff9fd9a`, including project isolation, queued-job restore and
actual Codex OAuth refresh after expiry, passed. The Codex-only provider fix
was separately approved in PR #10. Exact evidence is in deployment.md.
Sprint 4 implementation is merged in PR #12 (`d2c570a`); its release record
reports deployed Context 0.4.0. Its work-permission/evidence slice does not
execute tasks autonomously. Human-confirmation end-to-end acceptance remains
unverified. The owner stopped manual signing and further technical development
to evaluate the existing core; see deployment.md. A simpler confirmation through
a trusted authenticated environment is a product requirement, not an implemented
replacement for the current protection.

## Purpose

Context preserves continuity from a raw thought to an approved decision and a
verified result. The original source material and the current interpretation
must be separately retrievable.

```text
ChatGPT plugin       Codex MCP client      Future capture sources
      \                    |                    /
       \                   |                   /
        +------ Authenticated MCP API --------+
                          |
                    Context service
                          |
              Source store + metadata
                 SQLite + blob volume
                          |
               Derived search / views
                 FTS first, vectors later
                          |
           Optional enrichment / planning
                          |
              GitHub evidence adapters
```

Dokploy hosts the service; it does not authenticate MCP users or own personal
memory. Auth is implemented by Context or a compatible independent OAuth
provider. A public HTTPS endpoint is not a public data permission.

## Product direction after core validation

**Owner-approved intent (27 October 2026), not an implemented feature set:**
Context is a headless, client-agnostic Personal Context Engine. Its usefulness
should not depend on a particular input application, model vendor, storage
backend or hosting platform. Existing ChatGPT/Codex, SQLite and
Dokploy/Keycloak paths are concrete pilot integrations, not mandatory future
deployments. Keep persistence and retrieval working when no inference worker
is available.

**Separate security scopes from meaning.** Today's scope protects who can
read a source; it is not the source's topic or single project assignment. In a
future low-friction inbox, the user should be able to capture a note without
manual tagging. Inferred topics and multi-project associations must not grant
new access, promote private material to shared context or imply disclosure
approval. Keep source bytes and approval evidence independent of model output.

**Post-core evidence:** In a local 60-note / six-month synthetic evaluation,
source retrieval produced 10/12 complete grounded answers both before and
after processing. The worker generated 90 suggested knowledge items but no
stored relationships and no measured retrieval lift in that single comparison.
An answering model performed thematic synthesis from original snippets. This
motivates testing retrieval over derived knowledge and longitudinal
consolidation **as hypotheses**, not implementing a graph/RAG stack by default.
See [roadmap post-core validation](roadmap.md#post-core-product-validation--findings-and-candidate-experiments)
for limits and candidate acceptance.

**Usability risks are independent of memory quality:** reported recurrent
ChatGPT reauthorization and platform-blocked bulk write calls need diagnosis
with real client evidence. A locally successful Codex OAuth refresh or memory
worker job does not prove the end-user ChatGPT flow. Do not weaken existing
authorization to hide these symptoms.

## Data model, introduced incrementally

- `source`: original content, immutable ID, type, origin, timestamps,
  checksum, scope, provenance and optional private blob reference.
- `observation`: extracted or suggested interpretation, source links,
  extractor/version and explicit unverified/reviewed status.
- `decision`: human-approved intention, decision evidence, supersession,
  effective dates and related project references.
- `relation`: an explainable association, user-created or inferred,
  including source references.
- `execution`: externally verifiable issue, PR, checks, merge and deployment
  evidence, recorded as separate states.

Do not create all tables up front. Begin with source storage and essential
metadata. An optional vector index is a *derived search index*, not a source
of authority. Query filters and authorization must be applied before returning
data to any model.

## Implemented Sprint 3 boundaries

Source metadata and bounded UTF-8 originals live in additive SQLite tables.
Original file bytes, sources, FTS and retry keys commit together; online
snapshots contain the complete material. The v1 source shape remains unchanged.

Knowledge items and relations cite existing same-scope sources. Exact quotes
are checked against immutable originals. Creation attribution is untrusted;
items begin as suggested, and a suggested supersedes relation cannot change
decision status. Owner review requires an Ed25519 receipt verified against an
independently selected trusted key outside MCP. Append-only events retain the
signed receipt, reviewer key fingerprint and server timestamp.

Processing jobs use bounded retries and exclusive expiring leases. Validated
model output is saved before knowledge writes; retries replay it with stable
per-item keys. Sources remain available after failed processing. The actual
subscription experiment uses an explicit local Codex CLI worker. HTTP requests
only queue jobs, and the deployed runtime has no model credentials or automatic
paid fallback. Hosted subscription processing remains unverified.

Project context reads one authorized scope, includes full original evidence for
each derived item/link, and has an explicit UTF-8 payload budget. Unavailable or
oversized grounding omits a whole entry with a truncation indicator. Every MCP
operation intersects signed token operation/data scopes with operator-configured
client grants; project arguments never grant access. This remains one owner with
the two existing clients, rather than a multi-tenant permission model.

## Sprint 4 work-evidence boundary

An immutable work authorization binds an existing same-scope decision proposal
to its exact current signed approval, public GitHub repository and source/base
branches, required CI names and explicit dispatch/disclosure permission. It is
independently signed with the same trusted owner key and a different protocol
domain. The operator imports it locally; MCP can only read the resulting chain.
Approval revocation or replacement disables the old authorization.

Explicit operator refresh reads public GitHub REST with no credentials, fixed
API origin, bounded time/bytes/counts, no redirects and no source-text disclosure.
It verifies repository, branches, exact head SHA and stable PR facts across the
read. Immutable observations separate PR state, check results, merge and unknown
deployment. An open or failed PR cannot verify a result, nor can an old merged
PR complete a newly authorized intent. Failed refresh is itself an observation,
so stale success cannot silently stand in for current verification.

`work_context` returns one exact authorized work chain with complete originals,
signed review and authorization, latest observation and bounded older evidence.
Its UTF-8 budget drops whole older observations only; missing room for the
complete rationale/latest fact returns an error. It is sufficient for a fresh
planner without other projects or personal history. Tables are additive and
included in existing SQLite backup/restore. No hosted model, dispatch engine,
GitHub write or live deployment verifier is introduced.

## Initial MCP contract

Provide two versioned, intentionally narrow tools:

- `capture`: insert a short synthetic text item, with origin descriptor,
  scope, request ID/idempotency key and conservative status. Return ID,
  stored timestamp and stored status. A user-requested status is **not by
  itself** proof of human approval.
- `recall`: retrieve a known ID or search stored synthetic text, constrained
  by verified caller scopes. Return source/provenance and explicit status.

Prefer the official MCP TypeScript SDK with Streamable HTTP transport and
SQLite FTS. Use MCP Inspector and a second client to validate the contract.
Keep API mechanics and persistence behind simple interfaces.

## Authentication options

ChatGPT Plugins currently support no-auth, OAuth, and mixed authentication
for compatible MCP connections. For **real private memory** use OAuth 2.1 or
an equally supported authenticated path; use authorization-code flow,
supported client registration (CIMD/DCR as applicable), token scopes, audience
validation and revocation/expiry behavior.

- Dokploy does not supply an OAuth identity provider just by hosting an app.
- During local testing, no-auth may be enabled **only for synthetic isolated
  fixtures** in a nonpublic environment.
- Before any hosted personal-data pilot, independently validate that the
  configured OAuth provider and ChatGPT linking actually work end to end.
- Do not embed bearer tokens in URLs or source code; do not bypass browser
  login by treating arbitrary request text as approval.
- A Secure MCP Tunnel may be explored for private connectivity, but it does
  not replace user authorization or by itself host a login provider.
- Expose health separately from private MCP data.

ChatGPT write functionality must be demonstrated with an actual plugin
invocation; discovered tools alone are not enough. Codex must use appropriately
limited credentials rather than inheriting all personal memory.

## Future layers, conditional on earlier proof

1. Files/voice/images: original bytes, reproducible derived text, job queue.
2. Memory: reviewable observations, links, eventual semantic search.
3. Project projection: least-privilege context package for one project.
4. Planning: human-approved sprint, GitHub task and traceable results.

Mastra may be evaluated as a workflow/memory implementation detail **after**
the simple MCP capture/recall experiment works. Do not introduce it solely
because it has memory or orchestration features.

## Open questions

- How can consequential actions receive simple user confirmation in an existing
  trusted authenticated environment, without manual keys or JSON? Investigation
  and implementation are not currently authorized.
- Can a hosted subscription worker be supported with independently verified
  credential refresh, quota handling and outbound source permissions?
- What off-host backup/recovery arrangement should be separately authorized?
- Which retrieval benchmark would justify vectors over the current FTS and
  structured scoped context?
