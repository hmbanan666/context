# Remove experiments outside personal memory

Status: Accepted  
Date: 2026-11-02

## Context

Signed work tracking and synthetic access models obscure the everyday
save/reopen/ask journey and increase maintenance cost.

## Decision

Remove Ed25519 owner signatures/review receipts, work evidence (`work_context`
and GitHub evidence), synthetic scopes and `project_context` in stage 1a.
Keep historical code and evidence in Git history. GitHub PR ingestion remains
planned as an import, not as a work-evidence or dispatch-authorization system.

## Consequences

Remove obsolete interfaces and their dependencies together, without turning a
protected operation into an unsigned bypass. Preserve ordinary memory, provenance
and access isolation through the cleanup. Synthetic fixtures remain mandatory in
the public repo; removing synthetic product scopes does not permit real test data.
Keycloak removal belongs to stage 1b; this ADR does not claim any removal has shipped.
