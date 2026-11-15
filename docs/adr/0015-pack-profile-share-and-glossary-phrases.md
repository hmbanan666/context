# Keep a task pack's profile inside a fifth of the budget

Status: Accepted

Date: 2026-11-15

## Context

ADR 0013 ranks a pack by the task and reserves part of the budget for raw
sources. ADR 0014 expands a project glossary into FTS. On a live project with
`budgetBytes` 4096 the profile was still about 1.7 KB, so one decision fit.

For the expi task "добавить таймфрейм на график Matrix" the pack showed the
pull-request body and not the shorter distilled decision that cites it. For
the context task "улучшить ночную дистилляцию" that one decision slot was a
nightly-backup neighbour. Glossary terms were single tokens, so the phrases
«ночная уборка», «список покупок» and «источник истины» were rejected.
Snowball already stems ночную and ночная to ночн. It leaves список/списка and
покупок/покупки one fleeting vowel apart.

## Decision

This amends the pack budget and relevance floor of ADR 0013, and the glossary
shape of ADR 0014. `tools/list` stays `search`, `remember`, `read` and
`timeline`. There is no schema migration and no embedding reindex.

**Profile share.** A pack renders at most 20% of `budgetBytes` as profile
text: the purpose, then whole rules sentences that fit, then pinned in-force
sentences that fit, then the project's glossary trimmed at term boundaries.
The stored profile stays at most 2048 UTF-8 bytes. The processor still cannot
write it. `read` of `profile:<id>` returns that stored profile, including
rules and pins the pack left out. If the capped card itself exceeds the
budget, the pack is a prefix of that card and nothing else.

**Distilled instead of raw.** When a raw source would enter the pack and a
non-rejected, non-superseded decision or fact cites it, the pack takes that
item and omits the source. A decision is preferred to a fact, then the
shorter text. The item inherits the source's hybrid score when its own score
is lower, so a Russian pull request can bring in the English decision that
cites it. A source whose distilled items all fell below the floor is omitted
too.

**Floor and slots.** A row with no hybrid hit stays out. When any candidate
matches two or more glossary concepts, the pack drops rows that match neither
the caller's own words nor two concepts. A nightly-backup neighbour of a
distillation query is dropped once a distillation hit exists, and it stays
when nothing stronger matched. A decision that does not fit does not block a
later shorter one. At 4096 the smaller profile leaves room for 3–5 decisions
that clear the floor. The 25% source share and the 15% journal share are
unchanged.

**Phrases.** A glossary term, and each of its 1–8 synonyms, is one to four
words of letters or digits, at most 64 characters. A project still holds at
most 32 terms. A multi-word synonym is one FTS phrase. Matching compares
Snowball stems. One inserted о, е or ё still matches, which is how список
meets списка and покупок meets покупки. A bare prefix does not, so ночн does
not match ночник. Phrases the old one-token check rejected have to be set
again. Rows that were already stored stay valid.

## Consequences

Callers still convert a token budget to bytes. Omitting `mode` leaves
evidence search unchanged, apart from phrase expansion when the query hits
the glossary. Area-wide search uses the same phrase match. Timeline does not.
The public project fixture covers the distillation pack and a synthetic
matrix pack. Private questions stay private (ADR 0006).

Amended by [ADR 0016](0016-merged-hybrid-rank.md): a glossary concept in the
floor is a query word matched by that word or by a synonym. Two synonyms of
one word are still one concept.
