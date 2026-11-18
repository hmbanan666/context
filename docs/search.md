# Local hybrid search

Stage 3 search is merged in #28 and owner-confirmed deployed on 2 November 2026.
The simplicity audit did not inspect production or repeat hosted acceptance. No new
service, environment variable or model credential is required. The image includes
quantized `Xenova/multilingual-e5-small`; startup automatically backfills existing
sources and knowledge, and new captures/imports enqueue their stored text. Capture
never waits for a model. A missing/unavailable model logs `embeddings_unavailable`
without record content and automatically falls back to exact plus stemmed search.
The process listens before it loads the model. After listen, it loads the model
and embeds an English question and a Russian question in the background. An
ASCII-only probe leaves the first Cyrillic query to initialize the tokenizer
and the runtime, which can spend the two-second query budget. Both probes
finish before `{"event":"embeddings_ready"}` on stderr. That line is not
written to stdout. The same warmup stems those questions so the first search
does not compile that path either.
`/health` reports `embeddings` as `warming`, `ready`, or `off`.

Ask through the existing `context_package` MCP tool. Its output fields, provenance,
source excerpts, date semantics, entry/byte limits and one-hop relations stay the
same. A stored source that contains a Cursor pull-request footer
(`CURSOR_AGENT_PR_BODY` markers and the Open in Web / Open in Cursor badge HTML)
keeps that text for provenance. The derived FTS, stemmed index, embeddings and
excerpts drop the markers and the badge and keep prose before and after them.
A change to that rule rebuilds the derived source index once. `recall` retains exact phrase/ID
lookup, and `memory_context` retains literal keyword filtering and paged timelines.
Neither requires model availability.

## Grounding

`search` adds `grounding`: `strong`, `weak`, or `none`. The value is absolute
evidence, not the rank of the first card. A card can be first and still be
`none`.

Lexical evidence looks at one passage at a time. A passage is the same chunk
the embedding index stores: at most 256 UTF-16 code units, overlapping the
next chunk by 64. Query terms count only when they co-occur inside that
window, exact or stemmed. Terms scattered across a long note do not add up.
Glossary synonyms do not count.

Each content term is weighted by inverse document frequency over the same
pool the search can match. That pool is the current sources in the area, or
in the project when the search is project-scoped, plus the knowledge rows
that search returns. A project pool includes journals, decisions and facts,
so a word that occurs only in a journal is not document frequency 0. An area
pool leaves those three kinds out. Older revisions of a document are left
out. A `kind: "doc"` search counts only the current documents that filter
returns and does not count knowledge. A date window does not shrink the
count.
A term is common when that corpus has at least 40 records
(`CONTEXT_GROUNDING_COMMON_CORPUS`), the stem occurs in at least 8
(`CONTEXT_GROUNDING_COMMON_MIN_DF`), and those records are at least 5% of
the corpus (`CONTEXT_GROUNDING_COMMON_RATE`). Common terms stay in the
denominator and do not count toward `strong`. A note that only contains
ordinary words such as "weather" or "2018" is not strong evidence. On a
smaller corpus nothing is common, so a specific note still counts. The
project's id, its name, and its glossary terms are never common, even when
they occur throughout that project. Glossary synonyms are not protected.

The uncommon share is the IDF of the uncommon terms matched in the best
window, divided by the IDF of every content term. With embeddings, that
share must reach `CONTEXT_GROUNDING_LEXICAL_STRONG` (default `0.5`) and the
margin must reach `CONTEXT_GROUNDING_MARGIN_STRONG` (default `0.08`) to be
`strong`. The margin is the evidence cosine minus the cosine of the query
against a cached centroid of the passage vectors in that area, or in that
project when the search is project-scoped. The centroid is the mean of
those normalized chunk vectors, normalized again, and it is recomputed when
the chunk set changes. With no embeddings, the share must reach the
stricter `CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG` (default `0.75`) and the
margin is not used. On that path a share below
`CONTEXT_GROUNDING_LEXICAL_NONE` (default `0.30`) is `none`.
The margin is also skipped when the scoped corpus has fewer than
`CONTEXT_GROUNDING_MARGIN_MIN_CORPUS` records (default `6`). A handful of
notes makes the centroid almost the same vector as the passage, so an exact
hit would otherwise stay `weak`. Below that size the lexical-only rules
apply: an exact match can be `strong`, and an off-topic query stays `none`.
A corpus at or above the floor keeps the margin, including the public
calibration sets.

Question words and other function words do not enter the uncommon share, in
Russian or English. The list includes как, о, чём, чем, нет, how, what,
where, can, you, explain, and work (as in "how does it work"), and a
one-letter token such as the s in bot's. A missing question word would
otherwise take the highest weight, because its document frequency is zero.
Those words stay out of both the numerator and the denominator. A stored title is
read with the first passage window for this check only. Chunk offsets stay
on the body, so a stored vector still belongs to that window. A question
that repeats the title can be strong when the body never repeats the
distinctive word.

With embeddings, the result is `none` when the uncommon share is below
`CONTEXT_GROUNDING_LEXICAL_NONE` (default `0.30`) and the margin is below
`CONTEXT_GROUNDING_MARGIN_WEAK` (default `0.024`). That includes a passage
that matched a rare term, when the match is only a small part of the query.
Otherwise the older rules apply. If no rare term matched, common words are
not evidence: margin below the weak floor is `none`, and at or above that
floor is `weak`. Margin alone reaches `strong` only when no query term
matched at all and the margin reaches `0.08`. When a passage does contain
a rare query term and the none rule did not fire, the margin is read from
that passage, not from a different card.

Search keeps vector hits only at cosine 0.80 or above, and at most 20
records, so the passage that carried the rare term can be missing from
that list. Grounding then reads the stored chunk vector and dots it with
the query already embedded for search. It does not embed the passage
again. `cosineSource` is `vector` when that cosine, or a search hit, was
used, and `missing` when the chunk has no stored vector for this model. A
missing cosine counts as 0, so the margin is about minus the centroid.
A rendered profile section has no chunk row and stays `missing`.

On the public curated fixture with multilingual-e5-small, on-topic margin
was 0.014–0.081 (median 0.032) and off-topic margin was negative, because
those neighbours stayed under the 0.80 retrieval floor. On the mixed
corpus, off-topic margin reached 0.109 (median 0.069) while absolute
cosine reached 0.928, so a cosine cut does not separate the classes. A
project-scoped calibration separated on-topic from off-topic with margin
`0.024` or rare share `0.30`. `0.024` / `0.08` stay the defaults while the
public curated and mixed evals, lexical and semantic, stay green. A large
private corpus compresses E5 cosines further. Calibrate with
`context grounding explain --file` on the database you search. The field is
not charged against the evidence byte budget.

`context grounding explain` runs this same search and prints the label, the
rule that fired, the best cosine, whether the evidence cosine came from a
vector or was missing, the background cosine, the margin, the rare-term
share, the rare terms that matched, the common terms dropped, the corpus
size and document frequencies, and the top hit id and title. It does not
write thresholds.

```sh
context grounding explain --query "where is the lantern" --area studio
context grounding explain --file questions.yaml --area studio --json
```

`questions.yaml` is a list of `query`, optional `project`, and
`expect: on` or `off`. Each question can name its own project; a question
that omits `project` uses `--project` when that flag is set. The file
report adds the on/off distribution of cosine, rare-term share, and margin,
and the single cosine cut, rare-share cut, margin cut, and combined
rare-share and margin rule that separate the two classes. Use that margin
cut to choose `CONTEXT_GROUNDING_MARGIN_WEAK` and
`CONTEXT_GROUNDING_MARGIN_STRONG`. Defaults stay as above.

When `grounding` is `none`, the agent should say it does not know. Similarity
and rank are not permission to answer from an unrelated page. `search` accepts
`whenNone: "empty"` to return no cards in that case, and `whenNone: "keep"` to
leave them. Omitting it follows `CONTEXT_SEARCH_WHEN_NONE`, which defaults to
`keep`. `empty` sets `cardsOmitted` to `grounding-none` and clears `sources`,
`items`, and `relations`. The `grounding` field stays `none`. A curated or
agent-memory instance that should not hand the model an off-topic page sets
`CONTEXT_SEARCH_WHEN_NONE=empty`.

On a scoped corpus smaller than `CONTEXT_GROUNDING_MARGIN_MIN_CORPUS`,
search omits source cards whose match score is below
`CONTEXT_SEARCH_CARD_FLOOR` (default `0.5`) times the best source card.
The compared score is the hybrid rank score plus how many distinctive terms
the card contains, counted on the title and the body with the same stemming
as grounding. Function words are ignored. A term in half or more of that
small corpus is ignored too, so бот or сайт does not keep every note.
When no card contains a distinctive term, the floor does not run, so a
document status boost cannot drop another copy of the same words.
`0` turns the floor off. A corpus at or
above that size does not use the floor, so a lower-ranked hit in the public
eval sets stays. The best card is kept. Knowledge cards are unchanged.

When `items` is empty and the processor is off, search adds `itemsHint` with
the text `Items are empty because the processor is off.` Sources are still
returned. The hint is not an error and is not charged against the evidence
byte budget.

`search` also returns `tookMs`, the server wall-clock time for that call in
whole milliseconds. Pack mode includes it too. `listProjects` does not search
and omits it. One stderr line is written per search:

```json
{"event":"search","tookMs":45,"embedMs":12,"retrievalMs":20,"groundingMs":8,"centroidMs":1,"frequencyMs":2,"passageMs":5}
```

`embedMs` is the query embedding, `retrievalMs` is vector and lexical
candidate lookup, and `groundingMs` is the centroid, document frequency, and
passage scoring. `centroidMs`, `frequencyMs`, and `passageMs` split that last
part. They are included in `groundingMs`, not added on top of it. The parts
are a breakdown of server work. `tookMs` is the whole call, so a slow line can
be separated from network latency. The line does not include the query. There
is no separate HTTP search route. The MCP `search` tool result is the HTTP
`/mcp` payload.

## Cross-lingual queries

ADR 0014 keeps `Xenova/multilingual-e5-small` (q8 ONNX **118,308,185 bytes**,
384 dimensions). `multilingual-e5-base` q8 is **278,647,662 bytes** and was not
selected: a reindex loads a second model, and two base copies do not fit the
1536 MiB limit. Prefixes remain `query: ` and `passage: `. The version string
is stored on every chunk. Search never scores a chunk whose model id differs.
While any other id remains in the area, coverage includes `embeddings_mixed`.

```sh
context reindex --embeddings
context reindex --embeddings --batch 8
```

The command loads the local model, embeds queued rows, and prints counts plus
the model id. It does not print source text. Rows that already have the current
id are skipped. Rerun it after a crash; a lease still held by the server waits
out the ten-minute lease. On a database that is already on this model the
command spends the load (about 2 seconds) and then reports an empty queue.

Project terms live beside the profile:

```sh
context project glossary show --id context
context project glossary set --id context --term дистилляция --synonyms distill,distillation,tidy
context project glossary unset --id context --term дистилляция
```

A term is one to four words. A multi-word synonym is one FTS phrase. Matching
uses Snowball stems, and one inserted о, е or ё still matches, so список meets
списка and покупок meets покупки. ночную and ночная already share a stem.
A built-in RU→EN list (backup, distill, nightly, embedding, and similar) applies
when the project has no entry for that stem. Expanded synonyms use FTS weight
0.35 against weight 1 for the caller's own words. When the query expands, the
score adds one for each query word matched by that word or by a synonym of it.
Two synonyms of one word count once. An exact original word only breaks ties.
A query that matches no glossary entry keeps reciprocal-rank fusion, so a
vector hit can still outrank one lexical token. In a pack, a row more than
one concept below the best coverage, or below half the query concepts, is
omitted when a stronger row exists. Without a glossary hit, a row below half
the top hybrid score is omitted. A short query is not emptied. The embedding
string is not expanded.
Timeline is not expanded.

Phrases the previous one-token check rejected are set again, with the phrase
in quotes:

```sh
context project glossary set --id context --term "ночная уборка" --synonyms "nightly tidy"
context project glossary set --id context --term "список покупок" --synonyms "shopping list"
context project glossary set --id context --term "источник истины" --synonyms "source of truth"
```

## Recovery and progress

Normally no command is needed. To repair derived search data, run inside the
container as its owner:

```sh
context index rebuild
# Equivalent when the executable is not on PATH:
node dist/scripts/context.js index rebuild
```

This transaction rebuilds both FTS indexes, clears derived vectors and requeues
stored sources/knowledge. It prints aggregate queue status and does not load a
second model. The running service resumes embedding in the background; if stopped,
it resumes on the next start. Original text, file bytes, provenance and retry keys
are unchanged. Rebuild safely invalidates any old in-flight embedding lease.

Read `processing_status` through an authorized MCP connection with `version: 1`
and the desired `scope`, omitting `id`. Its `embeddings` object reports queued,
running, completed and failed records, stored chunk count and the model version.
Counts are restricted to that area. Failures retry after a minute, up to three
attempts per record; restart or rebuild retries exhausted failures. Crash leases
expire after ten minutes. A model load failure is logged at most once per minute.
No raw model output, content or lease credential appears in status/logs.

While that area has queued/running embeddings, package coverage includes
`embeddings_pending`; failed records or a failed/timed-out query use
`embeddings_unavailable`.
A scan reaching the vector bound reports `vector_scan_limit`. Each reason sets
`truncated`. Coverage counts are the distinct union of lexical matches and the
bounded semantic candidate list, not an exhaustive count of semantic matches.
Similarity alone is neither truth nor authorization. Stemming handles many RU/EN
inflections; it is not full lemmatization and cannot resolve every word form.

## Implementation and limits

- `snowball-stemmers-js` 3.1.2 is a zero-dependency JavaScript package, BSD-3-Clause,
  generated from canonical Snowball algorithms with automated upstream release
  checks. RU/EN stemmed shadow FTS5 tables are migrated from existing rows and
  maintained on writes. Exact FTS indexes remain separate. See the
  [package and maintenance policy](https://github.com/QQSHI13/snowball-stemmers-js)
  and [upstream license](https://github.com/snowballstem/snowball/blob/main/COPYING).
- [Multilingual E5 small](https://huggingface.co/intfloat/multilingual-e5-small)
  is MIT-licensed, 384-dimensional and uses `query: ` / `passage: ` prefixes,
  mean pooling and normalized vectors. The
  [ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small) is pinned
  to revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, q8.
  Transformers.js 4.3.2 uses native CPU ONNX inference, two intra-op threads and
  one inter-op thread. Model files live at `/app/models` in the image; runtime
  remote loading and cache writes are disabled. Only image build fetches files.
- Overlapping chunks are at most 256 UTF-16 code units, with 64-unit overlap and
  intact surrogate pairs. SQLite stores normalized Float32 little-endian BLOBs
  per chunk with original offsets and a model/chunking version. Vectors, jobs
  and shadow indexes are derived; no new ingest path or source rewriting is added.
- A durable SQLite queue serializes background records, and a bounded in-process
  inference queue serializes model calls with at most eight pending calls. Query
  embedding waits at most two seconds before lexical fallback. Retry claims and
  rebuild invalidation support concurrent service/CLI use without duplicate vectors.
- Storage is capped at 50,000 chunks. Cosine search streams 256-row batches,
  keeps the top 20 distinct vector records per source/knowledge list with cosine
  at least 0.80, and yields between batches. There is no best-score gap filter.
  Exact, stemmed and vector lists each apply area/date filters before ranking and
  fusion; knowledge also checks source-area provenance and rejected status.
  Reciprocal rank fusion uses `weight / (60 + rank)`: exact and stemmed lists
  have weight 1 each; the vector list has fixed weight 5. Exact/stemmed matches
  remain eligible regardless of cosine. Packages still interleave source and
  knowledge candidates and expand only one relation hop.
- `skipLibCheck` skips upstream declaration-file validation because Transformers.js
  4.3.2/tokenizers declarations contain incompatible NodeNext imports and unrelated
  image-processor overrides. Strict checking of project code remains enabled.

## Synthetic resource measurements

Measured locally on Node 24.21.0, CPU only, two inference threads, no runtime
network (`fetch` explicitly disabled), with model files downloaded beforehand.
These are synthetic process measurements, not production load acceptance.

| Measurement | Observed |
| --- | --- |
| Model load | 2.07 s |
| RSS after load | 498.8 MiB |
| Short item, 145 mixed RU/EN characters, 20 runs | mean 14.0 ms, p95 20.1 ms |
| Long item, 2,900 characters / 15 chunks | 271 ms total |
| Background embedding of 100 short records | 1.57 s |
| Full hybrid package, 100 records, 20 RU/EN queries | mean 22.2 ms, p95 31.9 ms |
| Vector scan, 50,000 repeated synthetic chunks, 5 queries | mean 749 ms, p95 828 ms |
| Peak process RSS through scan | 661.4 MiB (671.3 MiB in an earlier run) |

These earlier server-only measurements motivated 1 GiB. Compose now recommends
**1.5 GiB** (`mem_limit: 1536m`) for the server plus one standalone eval CLI; see
the CLI measurements below. No additional volume is needed. Monitor hosted RSS and latency
under actual authentication, capture, backup and retrieval concurrency before
calling production capacity verified. The scan fixture repeats real embeddings
to measure SQLite/vector cost; it is not a 50,000-item relevance benchmark.

To reproduce from a checkout, with packages already installed:

```sh
pnpm run build
mkdir -p .output
node dist/scripts/download-search-model.js .output/models
node dist/scripts/benchmark-search.js .output/models
```

For ordinary local development, the optional one-time preparation command is
`node dist/scripts/download-search-model.js models`. The service always attempts
to use that fixed model directory; without it, lexical fallback works. Neither
command runs as part of `pnpm run check`: automated retrieval/queue tests inject
synthetic fake embedders and never download weights.

## Existing synthetic retrieval comparison

The existing 10-question `eval:context-package` corpus provides a small baseline,
not an LLM answer-quality score. The baseline is commit `1a84efc`, run in an
isolated checkout; the new lexical result uses the same corpus. A separate local
replay attached the real embedder to the same protected MCP fixture and drained
its background queue before running the package questions.

| Retrieval | Complete evidence | Mean expected-source recall | Mean precision |
| --- | --- | --- | --- |
| Original exact FTS | 7/10 | 0.746 | 0.80 |
| Exact + Snowball | 8/10 | 0.857 | 0.90 |
| Exact + Snowball + local E5, cosine ≥ 0.8 | 8/10 | 0.857 | 0.90 |

All three runs had zero tool errors and no package responses over 4,096 bytes.
The inflection case improves; the bounded period overview and broad English
paraphrase “Who overcame adversity?” remain incomplete. Before adding the
similarity floor, unrestricted positive cosine neighbours raised recall to 0.968
but reduced precision to 0.34 and failed the absent-evidence question. These are
historical measurements, not results for the current tuning. A 0.80 floor does
not guarantee absent evidence produces an empty package: weak vector neighbours
above it are accepted candidates and still need source-grounded interpretation.
Fake-embedder tests verify retrieval rules and access isolation deterministically.

## Merged synthetic eval harness

With the same frozen question file and k=10, `pnpm run eval:retrieval` at baseline
`7370702` reports hit@1 / expected-match recall@10 / MRR of **0.333333** each.
The rebased search branch reports **0.666667** each. Both runs complete with
**zero isolation violations**. Exact RU/EN cases remain correct, and both
inflection cases now pass; the two paraphrase cases remain misses. The denied-area
case passes and the placeholder is skipped in both runs.

The historical runs seeded no vectors and did not attach an embedder to eval.
Those numbers measure exact/stemmed retrieval and isolation, not E5 paraphrase
quality. Eval now attaches the same index as MCP, while the public CI corpus
still has no E5 vectors and explicitly reports semantic unavailable. The
real-model measurements above are separate. The PR records
the exact evaluated head, question-file hash and observed latency for both runs.

Private eval questions, actual hosted OAuth save/reopen/ask after inactivity and
Docker execution were not verified locally; container checks run in GitHub CI.

## Eval hybrid calibration

The eval wiring regression is confirmed with a fake-model protected MCP test:
MCP returned a vector-only source, while the old eval adapter returned no hits.
Both nightly and standalone eval now use that same index search path. Nightly
borrows the service's model; standalone eval opens the index read-only and warms
its own model before measuring queries. History includes search mode/model,
semantic availability and vector-only versus lexical-only question counts.

The earlier synthetic calibration used 12 fictional RU questions with EN passages
and six unrelated queries. It selected a 0.78 floor, 0.01 best-score gap and cap
10. The real-corpus calibration below supersedes that rule. The following
resource measurements were taken with the earlier configuration.

For resource measurement, repeat the twelve synthetic vectors to **14,550 stored
chunks**, leaving source text unchanged, then launch the actual CLI as a separate
process while the parent keeps its model loaded. This measures scan/memory cost,
not the relevance of 14,550 distinct passages. The CLI's kernel high-water RSS
was **646.4 MiB**, with parent RSS **569.1 MiB** at launch. Its full protected MCP
eval reported hit@1 / recall@10 / MRR **0.9167**, zero isolation violations,
**11 vector-only questions**, zero lexical-only questions, and latency p50
**216 ms**, p95 **374 ms**. The lexical control found none of these English
sources for Russian queries. Load/control time is excluded from query latency.

The owner-reported server RSS (~505 MiB) plus this CLI peak exceeds 1 GiB;
Compose therefore uses **1536m**, with no new environment variables or volumes.
Actual hosted cgroup usage and concurrent backup/capture remain unverified.
Nightly eval has no second model allocation.

Reproduce offline after downloading the public model once:

```sh
pnpm run build
node dist/scripts/download-search-model.js models
node dist/test/benchmark-eval.js
```

The script uses only [synthetic calibration pairs](../fixtures/evals/cross-language.ts),
prints scores/aggregate metrics/RSS and removes its temporary database/history.
It is deliberately separate from `pnpm run check`; tests use fake embedders.
Keep downloaded weights outside the default `models/` directory when running
model-free checks: process-start tests launch the real service and otherwise
load those optional weights.

## Real-corpus calibration (2026-11-02)

The architect reported 34 private RU/EN questions over approximately 1,750
imported sources (GitHub docs/PRs, Codex task reports and short assistant memory
notes), at k=10 through the same protected MCP path. Only aggregate results are
recorded here; this implementation task did not rerun the private evaluation.

| Retrieval | hit@1 | Any-expected-hit@10 | MRR |
| --- | ---: | ---: | ---: |
| Lexical only | 0.294 | 0.559 | 0.351 |
| Previous hybrid | 0.353 | 0.647 | 0.441 |
| Chosen: floor 0.80, cap 20, vector RRF weight 5 | 0.353 | 0.794 | 0.479 |

All runs had zero isolation violations. Hundreds of sources exceeded cosine
0.80 for any query, while the 0.01 gap admitted only 1–3 vector candidates.
Removing the gap lets vectors contribute; weight 5 compensates for exact and
stemmed lists rewarding the same lexical evidence twice. Absolute cosine is
not a reliable relevance threshold on this corpus; weak neighbours can remain.

## Current memory and nightly consolidation

After hybrid fusion, one scope-indexed relation lookup per result set resolves
canonical chains and superseded IDs. Duplicate cards collapse to a readable
canonical even if only the copy matched; canonical cards appear once. Resolution
follows the earliest recorded outgoing duplicate link; cycles choose their
lexicographically smallest member ID, consistently for every entry point.
Current candidates precede every historical candidate,
and history cards carry `supersededBy`. The same policy applies to literal-phrase
recall; exact-ID reads still return the requested original. Existing candidate,
area, provenance, date and byte bounds remain. Canonicals outside the requested
date range do not replace a hit. Raw matching coverage counts still describe
pre-collapse candidates, not unique displayed cards.

Tidy uses stored same-model E5 chunk vectors, averaged and renormalized per source;
it does not load a second model. Exact NFKC/whitespace-normalized text equality
(including identical checksums) needs no vectors. Both exact and vector dedup
require at least **80 normalized characters in each source**, preserving short
event titles as distinct history. Existing relations are retained. Near duplicates require cosine
**≥ 0.97**, length ratio **≥ 0.95**, token-set overlap **≥ 0.95**, and unchanged
numeric/negation tokens. Tidy uses the source creation date when present, otherwise
the capture date, for direction and oldest-first canonical choice, with insertion
order breaking canonical ties. Existing duplicate decisions take precedence over
date changes; tidy skips pairs linked in either direction and links that would
close a duplicate chain into a cycle.
These conservative guards keep `limit 3` / `limit 4` distinct even at cosine 1.
Synthetic tests cover threshold boundaries and this numeric counterexample;
private/real-model dedup precision has not been measured here.

Automatic LLM supersession was removed after owner-reported live runs produced
only **3 correct proposals out of 12** across three runs, even with note-only
filtering and a stricter prompt. Notes can contain several claims; replacing a
whole record can hide claims that remain valid. Clients that know the context
supersede explicitly through `remember` with `supersedes`; search demotion and
existing history links are unchanged.

Tidy keeps deterministic dedup and optional LLM inbox sorting, with up to 25
items per call and a hard cap of 12 calls per run for either processor. An
insertion-position inbox cursor resumes capped runs; uncertain or failed items
are revisited after the cursor wraps. Sorting needs no vectors. Content-free
history records processor, model, counts, duration and the last completed run's
time; old supersession fields are ignored when reading history. Deterministic
dedup always checks all selected sources and relation writes are idempotent.
Catalog and association are implemented: `search` and `timeline` accept an
optional `project` id, and `search` with `listProjects: true` returns at most
64 ids and names without searching. See
[ADR 0010](adr/0010-projects-in-the-understanding-layer.md). Nightly distillation
stores proposed facts and decisions (ADR 0011). Area-wide search still omits
those sentences, and `timeline` stays a source list. With a project id and no
dates, search ranks that project's journals, decisions and facts as one hybrid
list and returns at most two journals. A journal card is then at most 240
characters. With `since` or `until`, every weekly journal whose week
overlaps that window comes first, oldest week first and without the
two-journal cap, then decisions, then facts, including rows the query does not
match, and a journal card stays up to 480 characters. When those cards do not
all fit, each overlapping journal is shortened by the same cap on a sentence
boundary, down to about 200 characters, coverage reports `journals_truncated`,
and only the remaining bytes go to decisions and facts. A month of up to six
weeks fits in the default 8192 bytes. Each item is labelled with its
stored status, `proposed` or `approved`, and carries the source id and URL. A
raw source cited by a returned item is omitted. `budgetBytes` (2048–65536)
overrides the 8192-byte package budget. Journal paragraphs are the week's
summary in complete sentences for weeks that overlap the requested dates.
`citedIds` lists the item ids. Area-wide search omits journals. A decision
or fact excerpt starts at a sentence boundary and is trimmed only at the end,
on a whole sentence when one fits, so a card after a journal does not open
mid-sentence. Source excerpts stay anchored on the match. When a note
contains both Cyrillic and Latin text and the question is predominantly one
of those scripts, the source excerpt window is taken from a paragraph, line
or sentence in that script. A note in one script keeps the match anchor.
Word and sentence trimming is unchanged. Grounding still scores the same
passages.
The owner sets that status with `context project review`; distillation does
not. `search` with `mode: "pack"` returns one task pack for a project and a
task query (ADR 0013, amended by ADR 0015). Decisions and facts, proposed and
approved, are ranked by that project's hybrid search. An approved row is
boosted by 1.25. Recency breaks ties. Superseded and rejected rows stay out,
and a row with no hybrid hit is not added to fill the budget. When the query
hits the glossary, a row more than one concept below the best coverage, or
below half the query concepts, is left out if a stronger row exists. Otherwise
a row below half the top hybrid score is left out. A short query is not
emptied. The rendered profile is at most 20% of
`budgetBytes` (purpose, rules, pinned sentences that fit, then a trimmed
project glossary). The stored profile is what `read` returns for
`profile:<id>`. About 25% of `budgetBytes` is held for at most two raw sources
that no included item cites, excerpted on a sentence boundary, and about 15%
for at most two journals that match the task. A distilled decision or fact is
preferred to the raw source it cites. Unused reserved bytes go back to the
ranked items. The response includes `bytesUsed` and `budgetBytes`.
`budgetBytes` for a pack is 512–65536 and defaults to 8192. The pack trims
whole items and whole profile sentences to stay inside that UTF-8 budget. A
header names what was included or omitted. No processor runs at query time.

A document is a source ([ADR 0018](adr/0018-documents-are-versioned-sources.md)).
Search returns its current revision only. `kind: "doc"` and `docType`
(`adr`, `spec` or `note`) filter to those rows and omit distilled facts,
decisions and journals. An accepted ADR or an active
spec scores one point above an equal match, so a task pack can keep it in the
two source slots. A superseded, rejected or obsolete document scores half.
Read `doc:<project>:<type>:<key>` for the current text and `@<revision>` for
an older one. Pack mode does not take `kind` or `docType`.
