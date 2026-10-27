# Architecture hypothesis

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
Execution orchestration remains a proposal.

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

- How should the owner provision and operate a signing key outside agent
  access for real review receipts?
- Can a hosted subscription worker be supported with independently verified
  credential refresh, quota handling and outbound source permissions?
- What off-host backup/recovery arrangement should be separately authorized?
- Which retrieval benchmark would justify vectors over the current FTS and
  structured scoped context?
