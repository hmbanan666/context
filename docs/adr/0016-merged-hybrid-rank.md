# Rank undated project search as one hybrid list

Status: Accepted

Date: 2026-11-15

## Context

A private project eval missed eight questions for one reason. The expected
item was first or second within its kind, and vector rank 1 in seven of the
eight, but `packageCandidates` concatenated journals, then decisions, then
facts. The package kept that order, so the item landed 13th to 20th or past
the byte budget.

Journals average about 743 characters, about 1.4 KB on the card, and they
match almost any query. Four or five of them fill the default 8 KB budget.
A dated question such as what happened in October still needs every in-window
journal, so that kind order stays.

The glossary band made the same misses worse. Any original word added 2, and
two synonym concepts added 1. A nightly-backup decision that contained
«ночную» outranked an item that covered two of the three query concepts only
through synonyms.

## Decision

This amends the undated project-search order in ADR 0012 and the rank bands in
ADR 0014. ADR 0015's floor uses the concept count defined here. `tools/list`
stays `search`, `remember`, `read` and `timeline`. There is no schema migration
and no embedding reindex.

**One list.** When project search has no `since` and no `until`, journals,
decisions and facts are one list ordered by hybrid score. The package keeps at
most two journals; further journals are left out so a higher-scoring decision
or fact can use the slot and the byte budget. Other knowledge kinds stay after
that list. Raw sources cited by a returned item stay omitted.

**Dates.** When `since` or `until` is set, every weekly journal whose ISO week
overlaps `[since, until)` comes first, oldest week first. The two-journal cap
and the 240-character journal card apply only when both dates are omitted. A
week that starts before `since` and ends after it is included. Those journals
are reserved together before any decision or fact. Decisions, then facts,
follow, and only in the bytes those weeks left over. In-window decision and
fact rows that share no words with the query are still candidates, and a
lexical or semantic match still ranks ahead of the other rows of that kind.
Period questions keep using dates, not pack mode.

**Concepts.** `expandQueryTerms` returns each synonym with the query-word
indexes it came from. A phrase covers every word in the match. When the query
expanded, the score adds the number of query words matched, by the word itself
or by one of its synonyms, to the reciprocal-rank score. Two synonyms of one
word count once. An exact original token adds only a tie-break smaller than
one rank step. Pack ranking uses this same score. When that coverage is
available, the pack drops a row more than one concept below the best row, or
below half the query concepts, if a stronger row exists. A nightly-backup decision that matches one
word of «улучшить ночную дистилляцию» is dropped once a row covers two. An
original token does not keep it. A query that matches no glossary entry keeps
today's reciprocal-rank score, so a vector hit can still outrank one lexical
token, and the pack then drops a row below half the top hybrid score. The
floor does not empty a short query.

**Excerpts.** An undated journal card is at most 240 characters, still cut on
a sentence boundary when one fits. A dated journal card is at most 480.
When the overlapping weeks do not all fit at that size, each card is shortened
by the same cap, still on a sentence boundary, and not below about 200
characters, before a decision or fact is added. Coverage then includes
`journals_truncated`. A later shorter row does not take the bytes of a week
that was left out. A month of up to six weeks fits in the default 8192 bytes.
Decision and fact excerpts are unchanged.

**Eval.** A question may set `expected_any`, a list of acceptable ids. The
list is one matcher: it hits when any returned card uses one of those ids.
`item_id` inside `expected` still matches that one id. A question may use
either field or both. Both eval runners score it. Retrieval metrics treat any
satisfied matcher as a hit. Project recall is the fraction of matchers found,
with `expected_any` counting as one.

## Consequences

Undated project search no longer spends the budget on every matching journal
before the decision or fact the query actually covers. A dated overview lists
every overlapping week, oldest first, then decisions and facts. When the full
journal cards do not fit, they are shortened together instead of dropping the
last week. Callers still convert a token budget to bytes.
Omitting `project` leaves area-wide search unchanged apart from the shared
concept score. Private questions stay private (ADR 0006).
