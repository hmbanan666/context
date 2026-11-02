# Keep SQLite and add morphology and local semantic search

Status: Accepted  
Date: 2026-11-02

## Context

The existing SQLite archive works, but literal retrieval misses inflections and
paraphrases. One-owner operation should remain small and independent of paid search.

## Decision

Keep SQLite. Add full-text search with Russian and English morphology and
semantic embeddings from a small local model running on the server. No paid API
is used for embeddings. Search data is derived and rebuildable from sources.

## Consequences

Authorization and provenance apply to both search paths and their combined
results. Model choice and resource use must be measured against the eval set;
semantic similarity is neither evidence of truth nor permission. Current lexical
FTS remains the baseline until stage 3 delivers the new search behavior.
