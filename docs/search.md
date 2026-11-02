# Local hybrid search

Stage 3 adds search in the repository; this is not a deployment claim. No new
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
- Storage is capped at 50,000 chunks. Cosine search streams 256-row batches, keeps
  at most 101 distinct records per source/knowledge list and yields between batches.
  Exact, stemmed and vector lists each apply area/date filters before ranking and
  fusion; knowledge also checks source-area provenance and rejected status.
  E5 candidates below cosine 0.8 are omitted to avoid its high unrelated-text
  similarity baseline; exact/stemmed matches remain eligible regardless. This
  fixed model-specific cutoff favors precision and can miss weak paraphrases.
  Reciprocal rank fusion uses `1 / (60 + rank)` across those three lists. Packages
  still interleave source and knowledge candidates and expand only one relation hop.
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

Compose now recommends **1 GiB** (`mem_limit: 1g`); 512 MiB is insufficient even
for the measured workload. No additional volume is needed. Monitor hosted RSS and latency
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
but reduced precision to 0.34 and failed the absent-evidence question. The fixed
floor avoids that regression, at the cost of weaker paraphrases. The model also
successfully retrieves the synthetic backup/restore paraphrases in the resource
benchmark without shared English search terms. Fake-embedder integration tests
separately verify RU/EN paraphrase plumbing and access isolation deterministically.

## Merged synthetic eval harness

With the same frozen question file and k=10, `npm run eval:retrieval` at baseline
`7370702` reports hit@1 / expected-match recall@10 / MRR of **0.333333** each.
The rebased search branch reports **0.666667** each. Both runs complete with
**zero isolation violations**. Exact RU/EN cases remain correct, and both
inflection cases now pass; the two paraphrase cases remain misses. The denied-area
case passes and the placeholder is skipped in both runs.

This command seeds no vectors and the read-only eval MCP handler does not attach
an embedder. These numbers measure exact/stemmed retrieval and isolation, not E5
paraphrase quality. The real-model measurements above are separate. The PR records
the exact evaluated head, question-file hash and observed latency for both runs.

Private eval questions, actual hosted OAuth save/reopen/ask after inactivity and
Docker execution were not verified locally; container checks run in GitHub CI.
