# Experimental roadmap

**Planning snapshot:** 27 October 2026  
**Status:** Sprint 0 merged in PR #2 after CI and code review. Sprint 1 local
implementation prepared for review after owner approval to continue. Sprints
2–4 remain proposed; no milestone is automatically authorized.

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

- Preserve original text/media files; ingest safely using a retryable queue.
- Add observations, relations and supersession/review states.
- Evaluate RAG/vectors and/or Mastra only after retrieval benchmarks show
  an advantage over full-text search and ordinary structured queries.
- Test scope isolation (website context cannot reveal manuscript context).

**Acceptance:** no data loss on failed processing; inferred facts and human
decisions are distinct; all derived links cite original sources.

## Sprint 4 — Idea to verified work

**Outcome:** Link an approved intent to GitHub scope and an actual result.

- Build project-context projections and propose a scoped sprint.
- Require human approval for task dispatch and disclosure decisions.
- Fetch GitHub state independently; record PR, check results, merge and
  deployed evidence as distinct facts.
- Verify Codex can consume a context package without full personal history.

**Acceptance:** fresh planner retrieves why the task exists and what really
shipped, backed by original sources and GitHub evidence; failed or unmerged
PR does not count as completed.

## Not in current scope

General messenger, full personal OS, autonomous issue-watcher, UI-heavy graph,
multi-tenant product, paid hosted LLM processing, unsolicited PR merges or
unattended production deployment.

## Agent delivery protocol

One approved milestone and one narrow PR at a time. Use available engineering
Skills when useful. After each, report test evidence, blockers and the next
owner decision. Do not create a new task tracker merely to manage a pilot.
