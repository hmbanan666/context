# Local hybrid search

Stage 3 search is merged in #28 and owner-confirmed deployed on 2 November 2026.
The simplicity audit did not inspect production or repeat hosted acceptance. No new
service, environment variable or model credential is required. The image includes
quantized `Xenova/multilingual-e5-small`; startup automatically backfills existing
sources and knowledge, and new captures/imports enqueue their stored text. Capture
never waits for a model. A missing/unavailable model logs `embeddings_unavailable`
without record content and automatically falls back to exact plus stemmed search.

Ask through the existing `context_package` MCP tool. Its output fields, provenance,
source excerpts, date semantics, entry/byte limits and one-hop relations stay the
same. `recall` retains exact phrase/ID lookup, and `memory_context` retains literal
keyword filtering and paged timelines. Neither requires model availability.

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
npm run build
mkdir -p .output
node dist/scripts/download-search-model.js .output/models
node dist/scripts/benchmark-search.js .output/models
```

For ordinary local development, the optional one-time preparation command is
`node dist/scripts/download-search-model.js models`. The service always attempts
to use that fixed model directory; without it, lexical fallback works. Neither
command runs as part of `npm run check`: automated retrieval/queue tests inject
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

With the same frozen question file and k=10, `npm run eval:retrieval` at baseline
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
npm run build
node dist/scripts/download-search-model.js models
node dist/test/benchmark-eval.js
```

The script uses only [synthetic calibration pairs](../fixtures/evals/cross-language.ts),
prints scores/aggregate metrics/RSS and removes its temporary database/history.
It is deliberately separate from `npm run check`; tests use fake embedders.
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
close a duplicate chain into a cycle. Watermark windows use capture time so newly
imported old notes are considered.
These conservative guards keep `limit 3` / `limit 4` distinct even at cosine 1.
Synthetic tests cover threshold boundaries and this numeric counterexample;
private/real-model dedup precision has not been measured here.

Model candidates are non-duplicate pairs with cosine ≥ 0.85, each at most 1,500
characters, and at least one capture date since the last successful run (all on the
first run). The model receives both texts and effective dates labelled a/b and
returns indexed decisions `[{"index":0,"current":"a"|"b"|null},...]`; a choice more
than one minute older than the other is skipped without failure, otherwise a non-null choice links current → other.
Numeric changes rejected by dedup remain eligible even above 0.97.
At most 200 pairs are checked per run, in batches of up to 25. Superseding and
inbox sorting share a hard cap of 12 LLM calls for every processor. Content-free
history records `processor` and `llmCalls`, and retains insertion-position pair
and inbox cursors and a window end for capped runs; later runs finish that window
before advancing the success watermark. Failed/invalid model output skips a pair and is counted.
Missing vectors or invalid entries prevent advancing the model watermark; capped
windows finish their remaining pages before a clean replay retries skipped work.
Switching processor, model or the selected area set starts its own watermark. Deterministic dedup always checks all
selected sources and relation writes are idempotent. Topic distillation is deferred.
