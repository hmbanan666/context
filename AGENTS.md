# Instructions for agents

This repository is an experimental Context service, not a mandate to build a
general AI operating system.

Before implementation read README.md, docs/architecture.md, docs/roadmap.md
and docs/deployment.md. Inspect the actual repository state and current PRs.

## Boundaries

- Execute only a milestone explicitly approved by the owner. The roadmap does
  not authorize implementing future milestones automatically.
- Keep each change a small, testable vertical slice on a separate branch.
  Prepare focused pull requests with actual evidence. **Never merge or deploy
  without separate explicit owner approval.**
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
Avoid infrastructure or ticket-management bureaucracy.
