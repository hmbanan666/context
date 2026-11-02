# Measure quality with private and synthetic eval sets

Status: Accepted

Date: 2026-11-02

## Context

Passing storage tests does not establish useful, grounded answers about the
owner, and a public repository cannot contain their real questions or memory.

## Decision

Maintain an eval set of 20–30 real questions privately, with synthetic equivalents
in the public repository. Run evaluations after each change and nightly. Measure
grounded answers, source coverage and access isolation, recording regressions
as well as improvements.

## Consequences

Private questions, source material, expected answers and raw outputs never enter
Git, public CI artifacts or PR text. Public CI uses synthetic equivalents;
private runs need an owner-controlled execution environment. Stage 2 establishes
the set and change-by-change baseline; stage 4 adds nightly automation. Publish
only safe aggregate evidence and distinguish unrun private checks from passes.
