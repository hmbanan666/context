# Rank a task pack by the query

Status: Accepted

Date: 2026-11-14

## Context

ADR 0012 returns a pack as the profile, decisions in force, then facts newest
first. On a live project the distilled rows are still `proposed`, because owner
review is rare. The matching decision was omitted, and the newest unrelated
facts filled the byte budget, so raw sources never appeared. No project profile
was stored. A pack of generic facts is not a task pack.

## Decision

This amends only the task-pack portion of ADR 0012. Profile, journal generation,
approval, and project search with dates stay as they are. `tools/list` remains
`search`, `remember`, `read` and `timeline`.

**Ranking.** Decisions and facts are one list, ordered by the same hybrid rank
project search already uses: reciprocal rank fusion of exact FTS, Russian and
English stems, and E5 embedding hits when vectors exist. Recency is the
tie-break, then id. An approved row's score is multiplied by 1.25. That boost
wins a tie and a near-tie. A clearly better proposed match still ranks above a
weak approved one. Proposed decisions are included and labelled `proposed`.
Rejected rows and rows with a `supersedes` link are omitted. A pinned decision
stays in the profile and is not repeated.

**Relevance floor.** A decision or fact with no hybrid hit is omitted. The pack
does not add unrelated rows to fill the budget. A short pack is the result
when little matches.

**Budget.** After the profile, about 25% of the caller's byte budget is held
for at most two raw sources that the same hybrid rank returns and that no
included item cites. About 15% is held for at most two journals. A journal is
included only when it matches the task; among matches, the most recent weeks
come first. A source excerpt starts at a sentence boundary and ends on a
sentence when one fits. Unused reserved bytes go back to the ranked decisions
and facts. If the profile alone exceeds the budget, the response is still a
prefix of the profile and nothing else.

**Response.** The pack reports `budgetBytes` and `bytesUsed` (the UTF-8 length
of the JSON, including those fields). The header still lists included and
omitted sections: profile, decisions, facts, journals, sources. A journal is
not a decision and cannot supersede one.

## Consequences

Callers still convert a token budget to bytes. Omitting `mode` leaves evidence
search unchanged. A missing journal is still not an empty week. Acceptance
cases are the synthetic questions in
[the eval doc](../evals.md#project-memory-cases), including a proposed decision
older than unrelated newer facts and a Russian task. Private questions stay
private (ADR 0006).

Amended by [ADR 0015](0015-pack-profile-share-and-glossary-phrases.md): the
profile takes at most 20% of the budget, a raw source yields to the distilled
item that cites it, and a one-concept neighbour is omitted once a two-concept
hit exists.
