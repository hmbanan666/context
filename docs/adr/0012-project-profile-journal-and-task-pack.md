# Load a project profile and a budgeted task pack

Roadmap slices: profile and journal are 4d, approval is 4e, and pack mode is 4f.

Status: Accepted

Date: 2026-11-14

## Context

An architect client needs the standing rules of one project, a short account of
a week or a month, and a bounded pack for a task. The historical
`project_context` tool scored 0/10 complete evidence because it returned recent
noise; ADR 0008 removed it. A new discovered tool would add schema text to every
client turn, which works against a tight budget. The server already enforces a
UTF-8 byte budget on `search` and does not know the client's tokenizer.

## Decision

**Profile.** Each project has one owner-written profile in its home area:
purpose, then rules, then up to eight pinned decision ids. That stored document
is at most 2048 UTF-8 bytes. The processor never writes it. The always-loaded
section expands pinned decisions that are still in force, purpose first.

**Decisions in force.** An approved decision that has not been superseded.
Approval and rejection are explicit owner CLI actions. Processor output that
claims `approved` is stored as `proposed` or rejected, never as in force.

**Journal.** For each project and ISO week in the instance timezone (`TZ`),
tidy stores one replaceable paragraph of at most 800 characters built only from
that week's distilled facts and decisions. The paragraph names the project and
the week, then gives up to eight complete sentences: decisions first, then
facts, in the source language. A sentence that does not fit is left out whole.
Item ids are stored beside the paragraph and returned as `citations` on `read`
and `citedIds` on a search card. They are not written into the sentence. The
processor is not called. These sentences are already distilled, and another
model pass would spend a call cap to rewrite them and could leave the source
language. If a later change does call the processor, that call has to use the
existing processor, its own cap, and this sentence list as the fallback.
Nightly tidy refreshes the current week and the previous week when the summary
changes. `context tidy --journal-backfill` writes older weeks that have items,
at most 24 per run, and rewrites a paragraph whose text changed. That is how
to regenerate journals left by the older concatenated formatter. An unchanged
paragraph is not rewritten. Weeks with no distilled items have no journal
entry. A journal entry does not claim the week is complete, is not a decision,
and cannot supersede one.

**Project search.** With a `project` filter, `search` ranks that project's
journal entries, then decisions, then facts in the requested dates ahead of raw
sources. When `project` and `since` or `until` are set, those in-window rows
are candidates even when the query shares no words with them; a lexical or
semantic match ranks ahead of the other rows of the same kind, and the rest
follow by date. A raw source cited by a returned distilled item is omitted.
Raw sources are only uncited evidence that still fits the byte budget. `since`
and `until` keep today's meaning. Optional `budgetBytes` (2048–65536) overrides
the package byte budget; the default stays 8192. Omitting `project` leaves
area-wide search unchanged, including its mixed raw results.

**Task pack.** A pack is `search` with `mode: "pack"`, not a new tool. The mode
requires `project` and `budgetBytes` (512–65536). `query` is the task
description. The response is whole sections, in order, stopping before the
budget: the profile (purpose, rules, pinned in-force sentences), then other
decisions in force ranked by the existing project search against the task, then
approved facts newest first, then proposed facts newest first. Pinned
decisions are not repeated. Raw excerpts come last, and a source cited by an
included item is skipped. Journal entries are not part of a pack. If the profile
alone exceeds the budget, the response is a prefix of the profile and no other
section. Period questions use project search with dates, not pack mode.

`tools/list` remains `search`, `remember`, `read` and `timeline`. `mode: "pack"`
is a field on the discovered `search` tool. Hidden `context_package` modes stay
`search` and `timeline`.

## Consequences

A pack does not write prose answers and does not grant rights. Callers convert
a token budget to bytes themselves. Existing clients that omit `mode` and
`project` keep current results. A missing journal is not evidence that the week
was empty. Acceptance cases for project search and pack mode are the synthetic
questions in [the eval doc](../evals.md#project-memory-cases). Private questions
stay private (ADR 0006).
