# Preserve sources and derive revisable understanding

Status: Accepted

Date: 2026-11-02

## Context

Useful memory needs original evidence and changing interpretations, while the
owner must be able to remove sensitive information.

## Decision

Redact tokens, keys and passwords on ingest before storage. Store the resulting
raw sources immutably with provenance before interpretation. Build a separate
understanding layer of facts, decisions, projects and people; clients read it
first and verify against raw sources. A new fact supersedes the old current fact,
retaining the old one in history. Owner hard delete removes the record and all
derived items; the journal retains only a "deleted by owner" tombstone.

## Consequences

Immutability applies to the retained, redacted source, not a secret-bearing copy.
Derived claims retain source references and decision status; inference is not
owner approval. Failed processing cannot lose a saved source. Deletion must
cover derived search data, queued work and history, and recovery must not
silently resurrect deleted content. Backup retention and deletion reconciliation
need an explicit implementation contract before hard-delete acceptance.
