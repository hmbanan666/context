# Context Package MVP: reproducible synthetic comparison

Date: 28 October 2026. Baseline: main `a2afdc620cab6aaa0c6d847b63051b8a56600593`.
Status: local branch evidence; no merge or production deployment.

## Question and protocol

Can a bounded lexical package expose more task-relevant original evidence than
existing search, without sending the archive to a model? The corpus and oracle
are public synthetic fixtures in `test/fixtures/package-corpus.ts`. They contain
130 originals (129 personal, one forbidden scope), 124 manually authored suggested
knowledge items and one relation. Seven originals fall in the requested October
interval; 120 later distractors push useful knowledge out of the old recent-100
projection. One long original exceeds the 4096-byte response budget. Boundary
sources test different UTC offsets and exclusive November cutoff.

Ten fixed English/Russian questions cover a monthly overview, book stories,
one-hop cause, budget, long original, derived vocabulary, date boundary,
paraphrase, Russian inflection and a negative query. Expected source labels and
short original fact strings are scored **after** retrieval; the package does not
receive the oracle. Dates are explicit caller-resolved Berlin bounds for every
method that supports them. Only the overview uses explicit timeline mode.

Methods use actual MCP clients against a protected local handler, with generated
fixture JWT keys and unchanged owner/client/scope grants. Each method gets an
independent service session against the same persisted corpus, staying below the
unchanged 60-requests/minute gate. The initial combined rapid replay hit HTTP 429;
this was a harness error, not a retrieval outcome or reason to weaken rate limits.
No network model, paid API, real notes or production service is involved.

- **phrase:** existing `recall`, entire question as a literal phrase, limit 20.
- **memory-question:** `memory_context`, entire question as keyword input.
- **memory-keywords:** same tool with fixed hand-selected keywords from the
  fixture (not an automated query planner); one call. Overview omits the query.
- **memory-paged:** the same keyword query, following cursors and explicitly
  reading oversized originals, with a maximum of four MCP calls per question.
  This gives the baseline a useful client strategy beyond a naive phrase query.
- **project:** existing `project_context`, recent knowledge/material projection,
  without a question or date argument (its contract does not support them).
- **package:** new `context_package`, natural question, same dates and overview
  mode. No per-question synonym map or source-specific ranking rule.

Limit 8 and 4096 UTF-8 structured JSON bytes apply where supported. Legacy
`recall` and follow-up `read_material` have no byte-budget argument. Byte totals
exclude duplicated MCP text and transport framing; they are not token counts.

## Observed results

“Complete evidence” requires every expected source ID **and** each required
verbatim fact in returned originals/excerpts, no tool error, and no false positive
for the negative question. It measures whether evidence for a complete answer is
available; it does **not** grade an LLM's narrative, synthesis or hallucinations.
Source-ID completeness gives the same aggregate scores in this run. Recall is a
macro-average over nine answerable questions. Precision averages all ten: empty
results count as 1 only for the negative question, otherwise 0. Irrelevant results
on the negative question count as precision 0.

| Method | Complete evidence / 10 | Source recall | Precision | MCP calls | JSON bytes | Responses > 4 KiB | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| phrase | 1 | 0.0% | 10.0% | 10 | 260 | 0 | 0 |
| memory-question | 2 | 11.1% | 20.0% | 10 | 4,164 | 0 | 0 |
| memory-keywords | 3 | 29.4% | 50.0% | 10 | 4,430 | 0 | 0 |
| memory-paged | 5 | 50.0% | 60.0% | 14 | 22,497 | 2 | 0 |
| project | 0 | 0.0% | 0.0% | 10 | 38,210 | 0 | 0 |
| package | 7 | 74.6% | 80.0% | 10 | 13,641 | 0 | 0 |

The package improves complete evidence from **5/10 in 14 calls** with the stronger
paged baseline to **7/10 in 10 calls**, using 13,641 versus 22,497 structured bytes.
The smaller one-call keyword baseline supplies complete evidence for 3/10 at a
lower byte total. The two over-budget baseline responses are explicitly requested
full originals, not violations of `memory_context`'s own limit. All final replays
returned zero tool errors and zero unauthorized source IDs.

## Per-question gains, misses and regression

| Question | Paged baseline | Package | Package missing source IDs | Package missing original facts |
| --- | --- | --- | --- | --- |
| overview | complete (4 calls) | incomplete (1 calls) | launch, flood | launch, flood, long |
| book | incomplete (1 calls) | complete (1 calls) | none | none |
| delay | incomplete (1 calls) | complete (1 calls) | none | none |
| budget | complete (1 calls) | complete (1 calls) | none | none |
| long | complete (2 calls) | complete (1 calls) | none | none |
| rescue | incomplete (1 calls) | complete (1 calls) | none | none |
| boundary | complete (1 calls) | complete (1 calls) | none | none |
| paraphrase | incomplete (1 calls) | incomplete (1 calls) | rescue | rescue |
| inflection | incomplete (1 calls) | incomplete (1 calls) | long | long |
| absent | complete (1 calls) | complete (1 calls) | none | none |

- **Book and rescue:** words present only in existing derived knowledge expose
  the cited originals. This measures retrieval over supplied enrichment, not the
  quality, availability or value of automatic extraction. Without those derived
  texts, these two gains would not follow from this experiment.
- **Delay:** the stored relation brings in the flooding source, which contains no
  “amber launch” words. Both suggested endpoints and their source cards remain
  present; the tool does not assert an approved causal conclusion.
- **Long original:** a matching excerpt contains the required telescope fact in
  one bounded call. The full original remains available through `read_material`.
- **Overview regresses:** paged retrieval supplies all seven originals in four
  calls. At 4 KiB the package omits `launch` and `flood`, and its timeline excerpt
  for `long` does not contain the telescope fact. It reports `byte_limit` and
  excerpt truncation. Use the existing timeline cursor for complete period scans;
  do not describe the package as a complete monthly account.
- **Paraphrase and Russian inflection remain misses:** “overcame adversity” and
  “телескопах” have no literal match. An empty result with `exhaustive: false` is
  not evidence that no relevant memory exists. No embedding system is added to
  hide these two failures.
- **Project projection:** returns recent irrelevant noise, including on the
  negative query. Its output is not question/date-ranked; it remains useful for
  its existing contract rather than being changed by this PR.

Two independent complete package replays produced identical summary metrics.
Legacy methods were also replayed against an exported copy of baseline main,
with only the same evaluation harness added; per-method completeness, bytes,
calls, precision and error totals matched. This controls against accidentally
improving or weakening the baseline while implementing the new tool. UUIDs and
capture times vary, and ties may reorder equally ranked records.

## Reproduce and inspect

Use the pinned Node/npm versions and a disposable local checkout. No credentials
or external accounts are needed for the corpus and MCP comparison:

```sh
npm ci
npm run check
npm run eval:context-package
node dist/test/evaluate-context-package.js --baseline
```

The evaluator emits JSON containing every query/method's returned labels, missing
source IDs, missing fact labels, recall, precision, calls, bytes, over-budget
responses, error count and truncation. It deletes its temporary SQLite corpus on
exit. `--baseline` selects legacy methods without changing their implementation.
To independently run them on main, export the baseline commit to a temporary
directory, copy `test/evaluate-context-package.ts` and `test/fixtures/` there,
install dependencies, build and run the last command above. Do not reuse a real
memory database for these tests.

The focused integration test invokes the new tool through official MCP clients,
then `read_material` using returned scope/IDs and compares full originals and
checksums. Additional cases cover authorized read-only clients, missing operation
or data grants, forged extra scope, wrong owner, disabled private/no-auth access,
rejected knowledge, missing/foreign/invalid provenance, mixed-period references,
one-hop versus second-hop traversal, budget/candidate caps, exact Unicode
excerpts, old-database FTS backfill, subsequent inserts and backup/restore.

Observed verification commands:

```sh
npm run check                         # lint, typecheck, 93 tests passed
npm run eval:context-package           # comparison above
docker build -t context:ci .
npm run test:container                 # non-root restart, backup/restore, denial passed
npm run test:oauth-provider            # disposable real Keycloak suite passed
```

The provider fixture additionally reads the same synthetic personal source via
`context_package` before/after persisted reconnect and refreshed access, using
its unchanged operation/data grant. The first Docker attempt caught the evaluator
being placed under runtime scripts; moving it into `test/` fixed the build without
adding test dependencies to the production image. An old restart assertion was
updated from 15 to 16 non-personal tools. All existing tests remain enabled.

## Limits and next decision

This is one small hand-authored corpus, not a representative personal archive or
statistically established ranking result. No independent LLM answer sessions,
automatic enrichment quality, large-archive latency or backfill duration were
measured. Multi-hop reasoning, cross-language retrieval, synonyms, stemming,
semantic time inference and cross-scope joins are absent. All cited source dates
must fall inside the requested period; useful mixed-period knowledge can be
omitted. A bounded excerpt can omit a crucial fact even when its source ID is
present. Package coverage counts lexical/timeline candidates, not all semantically
relevant memories; timeline knowledge counts only the bounded source candidates.

There is enough measured benefit for this minimal lexical mechanism to be
reviewable, alongside its explicit timeline regression. Keep original timeline
pagination and follow-up reads. Do not expand the architecture on this evidence
alone. The next required approval is merge, and separately production deployment;
neither is performed by this task. Actual ChatGPT/Codex discovery and long-idle
use of the new tool remain unverified until an approved release.
