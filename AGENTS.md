# Instructions for agents

Context is an MIT, single-owner, self-hosted personal context engine: preserve
sources and give authorized clients useful, source-grounded context through MCP.

Before implementation read CONTEXT.md, docs/spec.md, README.md,
docs/architecture.md, docs/roadmap.md and docs/deployment.md; consult the relevant
accepted decisions in docs/adr/. Inspect the actual repository state and current
PRs. The owner-approved direction dated 2026-11-02 supersedes older stop statements;
the spec describes the target, while architecture/deployment describe current truth.

## Boundaries

- Work toward the current owner-approved outcome. Within it, make necessary
  implementation, test and documentation decisions without asking for each
  step. Current owner instructions supersede historical stop statements in
  documents. A roadmap candidate alone does not authorize a new milestone.
- Keep each change a small, testable vertical slice on a separate branch.
  Prepare focused pull requests with actual evidence. **Never merge or deploy
  without separate explicit owner approval.**
- Routine memory capture and retrieval within an authorized connection need
  no per-record signature or technical choices from the user. Save requested
  sources after secret redaction and before interpretation; expose clear success,
  failure and retry results. Use area for the access boundary, separate from
  topics; retain scope for OAuth and existing protocol fields.
- Keep consequential actions and external disclosure separately authorized.
  Stage 1a removes Ed25519 signatures/review receipts, work evidence, synthetic
  scopes and project_context. Remove obsolete interfaces and dependencies
  together; preserve authorization on retained operations. Until removal ships,
  do not bypass existing checks or claim the experiments are gone.
- Follow current implementation and tested behavior over design assumptions.
  Treat partial implementation, tested PR, merge and live deployment as
  different states.
- All public documentation and code comments are English.
- Use installed AI Hero Skills (e.g. TDD, implement, code-review, PR) when
  useful. They do not authorize creating extra issues, ADRs or tracker files.
- If ChatGPT plugin write, hosted OAuth, or subscription-backed model access
  is unavailable or unverified, report that honestly instead of faking success.

## Privacy and security

- Public repository: **synthetic fixtures only**. Do not commit real memory,
  private strategy, raw chat text, book excerpts, uploaded media, credentials
  or any production database contents. This applies to code, tests, docs and PR
  text. Keep the real 20–30-question eval set, its inputs, expected answers and
  outputs private; use synthetic equivalents in public CI. Removing synthetic
  product scopes does not relax this rule.
- Selected real notes may enter the owner-approved private pilot only after
  protected capture/read and backup/restore are verified for its activation.
  A private namespace in a test still contains synthetic fixtures only.
- The target ingest pipeline redacts tokens, keys and passwords before storage,
  then persists immutable sources with provenance before interpretation. Report
  unimplemented protections honestly. Never infer owner approval from similarity
  search or LLM output.
- Carry source provenance, decision status, area and timestamps. Enforce area
  read/write rights; reject missing/invalid authentication. Inbox fallback and
  automatic sorting must not bypass owner-authorized access/disclosure policy.
- No public anonymous capture or recall for private data. An explicitly
  isolated local/test-only no-auth mode may use synthetic data and must fail
  closed in deployed/production configurations.
- Treat MCP inputs as untrusted. Implement validation, size limits,
  idempotency and safe retries. Avoid emitting sensitive records in logs.
- Do not access other Dokploy applications, databases or secrets.
- Do not silently add paid APIs or circumvent subscription terms.

## Reporting

Summarize the concrete code changes, test commands and observed results,
remaining unknowns, evidence links and the exact next required approval.
Judge readiness by the user's save/reopen/ask journey, including authentication
after inactivity, rather than tests or tool discovery alone. Complete the
authorized preparation before requesting release approval. Avoid infrastructure
or ticket-management bureaucracy.
