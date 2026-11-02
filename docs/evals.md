# Retrieval evals

`context eval run` measures retrieval quality and area isolation against the live
SQLite database, opened read-only. It never creates sources or updates indexes,
authentication state or database schema. Run it inside the container as the
owner; no bearer token, external model provider or network connection is needed.
The CLI loads the same baked-in local E5 model as the server when current vectors
exist. It warms the model before timed queries and closes it after the run.

Place the private question file at **`/app/data/evals/questions.yaml`**. Results
append to **`/app/data/evals/history.jsonl`**, on the existing data volume. In local
development the same `evals/` convention lives beside `CONTEXT_DB_PATH` (default
`./data/context.db`). There are no new environment variables or volumes.

```sh
context eval run
context eval run --questions /app/data/evals/questions.yaml --k 10 --json
context eval history
context eval history --limit 20 --json
```

`run` defaults to k=10; k must be 1–20, matching the MCP package limit. `history`
shows ten recent runs, newest first (`--limit` accepts 1–100). `--json` emits only
the content-free result. In a built checkout use `npm run context -- eval ...`.

## Questions

YAML and JSON use the same root object, with a `questions` array. The file is
limited to 1 MiB and 500 questions; YAML aliases and duplicate keys are rejected.
Only synthetic questions belong in Git. See
[`fixtures/evals/example.yaml`](../fixtures/evals/example.yaml) for the public set.
Keep private questions, expected answers and history outside the repository.

```yaml
questions:
  - id: q01
    question: What does the cobalt iris need?
    areas: [garden]
    read_areas: [garden]
    expected:
      - source_external_id: https://fictional.example/iris
      - substring: needs shade
    forbidden_areas: [vault]
    tags: [en, exact]
  - id: q02
    question: Где фиалка?
    areas: [garden]
    read_areas: [garden]
    expected:
      - substring: возле окна
    tags: [ru]
```

| Field | Meaning |
| --- | --- |
| `id` | Unique opaque question ID, 1–64 ASCII letters, digits, `_` or `-`. Use IDs that contain no private facts; IDs are retained in history. |
| `question` | Nonblank natural-language RU/EN question, up to 512 characters. Search validity follows the current MCP implementation. |
| `areas` | Ordered array of 1–8 distinct areas to search. It grants no access. |
| `read_areas` | Simulated client's read rights, 0–8 distinct areas. Write/process rights are always empty. |
| `expected` | Up to 100 acceptable evidence matchers; any one match is a hit. Each object has exactly one of `source_external_id`, `source_id`, or `substring`. A source can satisfy several matchers. |
| `outranks` | Optional nonempty list of the same matchers: the first expected hit must rank above every returned matching historical hit. Requires `expected`. Missing history is allowed; missing expected evidence fails. Results add only `outranks_pass`, with no text. |
| `forbidden_areas` | Optional distinct areas whose results must never appear, default `[]`. These areas are also probed directly with the same client rights. |
| `tags` | Optional labels such as `inflection`, `paraphrase`, `ru`, `en`; kept in the private file, not the results. |
| `placeholder` | Optional boolean, default false. True skips the question completely, with null metrics and pass state. |

All mentioned areas must be configured by the existing `CONTEXT_AREAS`. A
non-placeholder needs at least one expected matcher or a forbidden area.
`expected: []` with `forbidden_areas` is an isolation-only case; it does not enter
retrieval-quality averages. Searching an area outside `read_areas` must produce
an MCP access denial, even if that area appears in `areas`.

`source_id` matches the immutable source ID. `source_external_id` matches the
imported **external ID** (`source_imports.external_id`) or **`metadata.sourceUri`
exactly**, including case. Use the imported item's `id` or stable source URL;
matching is still limited to returned sources in authorized areas. External IDs
can repeat across import sources, so use `source_id` or a distinct URL when a
question needs one specific source. `substring` is a literal, case-sensitive match in
a returned **source or knowledge excerpt**, not a search through the full stored
original. A knowledge excerpt is scored with each of its cited source cards.
These rules are fixed across search implementations.

## Retrieval and metrics

The harness calls `context_package` through the real protected MCP handler and
SDK, with explicit read-only client grants. The transport is in-process and has
no listener. It does not implement its own search or rank by SQL. Both CLI and
nightly eval attach the server's `EmbeddingIndex` search implementation, including
the same model version,
filters, vector selection and reciprocal rank fusion. Nightly eval borrows the
running server's index and inference queue; it never loads or closes a second
model. Separate read-only metadata
lookups resolve returned IDs for matching and audit their actual areas; they do
not select or rank candidates.

Rank means the order of source cards in the returned package, including source
cards cited by derived knowledge. Each source card carries its source excerpt and
the excerpts of returned knowledge items citing it for substring matching. MCP searches one area per call. With multiple
areas, the harness takes their first source cards in `areas` order, then their
second cards, and so on, deduplicating IDs and stopping at k. Each call requests
k entries and the MCP maximum 64 KiB package budget. It never compares internal
search scores between areas. Derived items and relations are audited for access
isolation but are not separate ranks in the source-quality metrics.

| Metric | Definition |
| --- | --- |
| `hit_at_1` | 1 if the first source card matches any expected matcher, otherwise 0. |
| `hit_at_k` | 1 if any of the top k source cards satisfies any expected matcher, otherwise 0. |
| `mrr` | Reciprocal rank of the first card satisfying any matcher; 0 if none in top k. The run reports the mean across questions. |
| `diagnostics.lexical` | Lexical-only control's `hit_at_1`, `hit_at_k` and `mrr`, scored by the same rules and macro-averaged over compared questions. Each metric is null when no questions were compared. |
| `isolation_violations` | Number of distinct unauthorized/forbidden records or access/scope breaches per question; summed across questions. All returned cards and provenance references are audited, even outside the combined top k. Must be zero. |
| `latency_ms` | Per-question wall time for setup, all MCP searches, isolation probes, auditing and cleanup. |
| `latency_p50_ms`, `latency_p95_ms` | Nearest-rank percentiles across non-placeholder questions, including failed attempts. |

Run quality metrics are macro averages across questions with expected matchers.
A question passes when any expected matcher is found in the top k and isolation holds;
isolation-only cases pass on isolation. Retrieval misses stay visible but do not
fail the command, so today's lexical misses can be compared with later search.
A failed retrieval attempt is reported as failed, never a successful empty search.
All-placeholder files have null quality/latency metrics, not a perfect score.

Exit codes: **0** for a completed run (including quality misses), **1** for invalid
options, input/storage/retrieval failure, **2** for any detected isolation violation.
Violations take precedence if a later search also fails.

## History and nightly runs

New rows use `schema_version: 2`. Every row records `search.mode` (`lexical` or
`hybrid`), `search.model` (the pinned model/revision/quantization/chunking ID), and
`search.semantic` (`available`, `unavailable`, or `partial`). Hybrid means at least
one authorized primary search actually ran vector inference and scanning, even if
no candidate cleared the ranking rule. Unavailable means none did: for example,
the model failed, the queue timed out, or the searched areas have no current-model
vectors. Partial means some primary searches used vectors and others fell back.
The text output explicitly says **`semantic: unavailable`** on fallback. A
completed lexical fallback still exits 0; inspect search status before comparing
quality. Skipped or denied-only runs cannot establish semantic availability.

Each run also records content-free `diagnostics`. The question counts are:

- `compared_questions`: completed questions with expected matchers compared with
  a second, lexical-only call through the same protected MCP path and grants.
- `vector_only_questions`: questions with at least one expected matcher found in
  hybrid top k but absent from lexical top k.
- `lexical_only_questions`: questions with at least one expected matcher found in
  lexical top k but absent from hybrid top k (possible ranking displacement).

These count questions, not sources. They use the existing source-ID, external-ID
and excerpt matcher rules, so substring matches can reflect excerpt differences.
They measure the contribution of adding vectors to the final package, not raw
vector candidate membership. Each question counts at most once in each category;
a multi-source question can count in both. Control time is excluded from primary
latency; isolation audits cover both paths without counting the same breach twice.
No source IDs, text or raw scores are persisted. Concurrent writes can affect the
sequential comparison; this is a diagnostic, not a frozen database snapshot.

`diagnostics.lexical` records the control's aggregate quality for those same
compared questions when an embedding index is attached, including lexical
fallback runs. Skipped, isolation-only and failed comparisons are excluded.
Text output shows one `lexical control: hit@1 … hit@k … mrr …` line beside the
primary metrics. The field is additive and optional in schema 2: older rows
without it remain readable and omit that line. New runs with no comparisons
record null for all three control metrics.

Each JSONL row contains the timestamp, run ID, package version and git SHA when
available, SHA-256 of the exact question-file bytes, k, outcome, aggregate metrics
and per-question IDs, pass/fail/skipped states and metrics. It contains no
questions, matchers, tags, areas, source IDs, excerpts or file paths. The container
records the package version when Git metadata is unavailable; CI/checkouts can
record the commit. Record the deployed image/commit alongside private comparisons
when package versions alone do not distinguish images.

`history` shows metric differences from the immediately preceding run only when
question-file hash, k and result schema match and both runs completed. Otherwise
`delta_previous` is null. Older schema-1 rows remain readable and are labelled
`search: unrecorded (legacy row)`; no delta bridges the schema change. Mode/model
changes remain visible alongside within-schema deltas. Positive quality deltas
are improvements; positive
latency or violation deltas are regressions. It reads history as a stream and
retains only the display window. New history files use mode `0600`, new containing
directories `0700`. History is append-only with no automatic retention. A malformed
history line fails the history command rather than silently dropping evidence.

Older rows used the fraction of satisfied matchers for `hit_at_k` and required
all matchers to pass. Across this scoring change, a delta can reflect the new
acceptable-evidence rule rather than changed retrieval; use fresh runs for
quality comparisons.

After each nightly backup attempt (successful or failed, excluding a busy lock),
the same process checks for the conventional questions file and runs the eval
with k=10 if present. It reuses the backup's time, timezone, daily catch-up and
restart behavior. There is no separate timer: disabling scheduled backups also
disables nightly evals. Manual backup commands do not trigger evals. No question
file means no eval or history file. Creating the file takes effect at the next
scheduled backup; no restart is required. Errors are logged as fixed status and
numeric metrics, with no private content or raw exceptions.

Eval questions and JSONL are files on the data volume, not tables in the main
SQLite database: the existing database snapshot does not back them up. Preserve
them privately with the data-volume files if needed. If the process exits after
persisting backup status but before completing eval, that day's eval may be
missing; `context eval run` supplies the manual retry. No separate job registry
is introduced.

## Synthetic verification and limits

```sh
npm run check
npm run eval:retrieval
```

The synthetic CI command builds a disposable fictional corpus, executes the real
CLI against [`example.yaml`](../fixtures/evals/example.yaml), checks exact RU/EN
retrieval and isolation, and prints only numeric results and question IDs. It
removes the temporary database/history afterward. The frozen inflection and
paraphrase cases record known lexical misses; improvements are allowed without
rewriting expectations. Current synthetic scores are 2/3 (0.666667) for hit@1,
hit@10 and MRR on both the primary and lexical-control paths, with zero isolation
violations. Exact RU/EN and both inflection questions pass; both paraphrases
remain misses. The isolation-only question passes and the placeholder is skipped.

Execution is sequential, with one bounded question file, bounded MCP packages and
no corpus copy or worker pool. CLI runs use one local model per process; nightly
runs reuse the server model. The CI corpus has no E5 vectors, so it remains
lexical and explicitly reports semantic unavailable. Regression tests supply
fake embedders and never download or load model weights. For optional real-model
calibration and CLI peak RSS, see [search measurements](search.md#eval-hybrid-calibration).
Read-only SQLite
connections may still require the live WAL/SHM files to be accessible. This is
retrieval evaluation, not answer-generation grading or proof of HTTP OAuth,
refresh/revocation, real-client inactivity, hosted performance or private quality.
Those remain separate acceptance checks. Concurrent capture changes the live
corpus, so record corpus changes when interpreting history deltas.
