# Architecture hypothesis

**Status:** Local source persistence and synthetic MCP capture/recall are
implemented (see README for the tested contract). An OAuth resource server and
Keycloak configuration are prepared; hosted authentication and real client
linking remain unverified. Later knowledge/execution layers remain proposals.

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

- Does the owner's current ChatGPT plugin connection permit private
  authenticated `capture` (actual write call)?
- Which OAuth provider offers the smallest compliant personal setup?
- How do we prove an approval originated from a real user instead of a model?
- Can Codex retrieve a scoped note from a new session with the same stable ID?
- Which subscription-backed LLM features actually work under permitted
  usage limits for future background enrichment?
