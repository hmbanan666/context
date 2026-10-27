# Context

**Experimental, self-hosted continuity engine for ideas, decisions and verified work.**

Context is not another messenger, general note-taking application, or autonomous
coding system. It is a small shared memory service for existing clients
(ChatGPT, Codex, and later others), intended to preserve the *reasons* for work,
not just a transcript or a list of tickets.

## Hypothesis

A user discusses an idea in their usual chat and explicitly requests
"capture this". A separate agent can later retrieve the authorized, grounded
context, turn an approved intention into work, and link the result back to
source material and verifiable evidence.

This repository contains open-source code and synthetic fixtures only.
**Do not commit real conversations, personal notes, manuscripts, documents,
uploads, credentials, tokens, or instance databases.**

## First meaningful end-to-end test

1. Save a synthetic note via the Context MCP `capture` tool in ChatGPT.
2. Verify that the original content, source, status and stable ID are persisted.
3. Retrieve that record using `recall` from a fresh Codex session.
4. Verify the same record survives process restart and is inaccessible outside
   its authorized scope.
5. Record exactly which parts have been demonstrated and which are still blocked.

No autonomous agents, RAG, Mastra, visual graph, or UI is necessary for this
first proof of usefulness.

## System boundaries

- **Capture first:** persist raw sources; AI interpretation is derived.
- **Decisions are explicit:** brainstorming, proposals, owner approval,
  implementation, PR, merge, and deployment are separate states.
- **Provenance is mandatory:** any derived observation refers to source IDs.
- **Portable access:** MCP offers narrow tools to authorized clients.
- **Private instance, public code:** repository does not contain personal data.
- **Subscription-first:** no paid LLM API requirements without owner approval.
- **Independent project:** do not merge this codebase with Dostigus,
  kosarev.space, K39, Woodlands or the private book project.

Architecture: [docs/architecture.md](docs/architecture.md)  
Milestones and acceptance: [docs/roadmap.md](docs/roadmap.md)  
Deployment: [docs/deployment.md](docs/deployment.md)  
Agent instructions: [AGENTS.md](AGENTS.md)

## Status

**Planning scaffold. No Context service, MCP endpoint, or plugin is deployed.**
The proposed integrations must be validated by actual calls, not inferred from
product documentation alone.

## Hosting

The intended host for later testing is an existing **Dokploy** installation,
as an independent application with its own persistent storage and a separately
approved HTTPS service hostname. The Dokploy administrative panel is **not**
the MCP endpoint and must not be treated as an OAuth provider.

## License

MIT.
