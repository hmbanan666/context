# Instructions for agents

Context is a headless Personal Context Engine: capture originals, preserve
them, and give authorized AI clients useful, source-grounded context.

Before implementation read README.md, docs/architecture.md, docs/roadmap.md
and docs/deployment.md. Inspect the actual repository state and current PRs.

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
  originals before interpretation; expose clear success, failure and retry
  results. Keep access scopes separate from inferred topics.
- Keep consequential actions and external disclosure separately authorized.
  Signed work-evidence tools are a separate legacy workflow, not a prerequisite
  for using memory. Preserve their checks while they remain available.
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
  or any production database contents.
- Selected real notes may enter the owner-approved private pilot only after
  protected capture/read and backup/restore are verified for its activation.
  A private namespace in a test still contains synthetic fixtures only.
- Persist immutable source input before attempting interpretation. Never
  infer owner approval from similarity search or LLM output.
- Carry source provenance, decision status, scope and timestamps. Enforce
  access scope on reads and writes; reject missing/invalid authentication.
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
