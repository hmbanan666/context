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
the content-free result. In a built checkout use `pnpm run context eval ...`.

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
| `expected` | Up to 100 evidence matchers. Any one match is a hit for retrieval metrics. Each object has exactly one of `source_external_id`, `source_id`, `item_id`, or `substring`. A source can satisfy several matchers. Project recall counts each matcher separately. | 
| `expected_any` | Optional list of 1–100 distinct ids. The group is one extra matcher: it hits when any returned card id is in the list. Use it when several item or source ids are acceptable. `item_id` inside `expected` still matches one id. A question may set either field, or both. |
| `outranks` | Optional nonempty list of the same matchers: the first expected hit must rank above every returned matching historical hit. Requires `expected` or `expected_any`. The first hit is the best rank among `expected` matchers and the `expected_any` group. Missing history is allowed; missing expected evidence fails. Results add only `outranks_pass`, with no text. |
| `forbidden_areas` | Optional distinct areas whose results must never appear, default `[]`. These areas are also probed directly with the same client rights. |
| `tags` | Optional labels such as `inflection`, `paraphrase`, `ru`, `en`; kept in the private file, not the results. |
| `placeholder` | Optional boolean, default false. True skips the question completely, with null metrics and pass state. |

All mentioned areas must be configured by the existing `CONTEXT_AREAS`. A
non-placeholder needs at least one expected matcher, an `expected_any` list, or a forbidden area.
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

The harness calls `search` through the real protected MCP handler and
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
pnpm run check
pnpm run eval:retrieval
```

The synthetic CI command builds disposable fictional corpora, executes the real
CLI against [`example.yaml`](../fixtures/evals/example.yaml) and
[`project-memory.yaml`](../fixtures/evals/project-memory.yaml), checks exact
RU/EN retrieval, the October project question and isolation, and prints only
numeric results and question IDs. It removes the temporary databases and
history afterward. Pack questions in the project-memory file are scored. The frozen inflection and
paraphrase cases record known lexical misses; improvements are allowed without
rewriting expectations. On `example.yaml`, hit@1, hit@10 and MRR are 0.75 on
both the primary and lexical-control paths, with zero isolation violations.
Slice 4d does not change that score: `example.yaml` has no project journals,
and the October corpus still has no journal row.
Exact RU/EN, both inflection questions, the current-fact question and the
duplicate-only question pass; both paraphrases remain misses.
The isolation-only question passes and the placeholder is skipped.
`october_on_project` scores 1 on its own corpus; the two pack questions pass.

Execution is sequential, with one bounded question file per run, bounded MCP
packages and no corpus copy or worker pool. CLI runs use one local model per process; nightly
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

## Project eval

ADR 0014 adds a second run that scores one file of project questions and prints
per-project recall@k and pack-hit rate. It opens the database read-only, attaches
the local model only when current vectors exist, and appends a content-free line
to `projects-history.jsonl` in the eval directory. It is not part of the nightly
backup schedule.

```sh
context eval projects
context eval projects --questions /app/data/evals/projects.yaml --k 10 --json
```

The default path is `evals/projects.yaml` beside the database (`/app/data/evals/projects.yaml`
in the container). `--questions` selects another file, which is how a private
prod set is run. `--k` is 1–20 and defaults to 10. `--json` prints the report
only. Question text, matchers and excerpts are not stored.

Recall@k for a question is the fraction of its expected matchers found in the
top k (or in the pack, still capped at k cards). `expected_any` counts as one
matcher and is found when any listed id is returned. Pack-hit rate is the fraction
of `mode: pack` questions that found every matcher, respected `outranks` and
forbidden substrings, and had no isolation violation. Both are macro-averaged
per project and overall. A question needs a `project`. `item_id` matches a
returned knowledge item id. `source_id`, `source_external_id` and `substring`
keep their existing meanings. Placeholders are skipped.

Public CI runs [`projects.yaml`](../fixtures/evals/projects.yaml): 12 Russian
questions for fictional project `context` and 13 for fictional project `expi`,
including `context_nightly_distill` ("улучшить ночную дистилляцию") and
`expi_matrix_pack` ("добавить таймфрейм на график Matrix"). The corpus is
synthetic. Real expi or context notes do not belong in that file. On that
fixture, with no vectors, recall@10 and pack-hit rate are both 1.

```sh
pnpm run eval:projects
```

Exit 0 when the run finishes, including retrieval misses. Exit 1 when the file,
database or a retrieval attempt fails. Exit 2 when any isolation violation is
counted.

## Project memory cases

ADRs 0010–0013 accept the public questions below.
`pnpm run eval:retrieval` runs
[`example.yaml`](../fixtures/evals/example.yaml) and
[`project-memory.yaml`](../fixtures/evals/project-memory.yaml). The harness
accepts `project`, `since`, `until`, `budget_bytes`, `forbidden_substrings`
and `expect_truncated`. `mode: pack` selects task-pack retrieval and is scored.
`october_on_project` is scored. Private questions, including any real "what happened in October on
project X" query, stay outside Git.

A question with `project` calls `search` and passes the project, dates and
byte budget. Hits are journal entries, then decisions, then facts, including
rows the question does not match when dates are set, then raw sources those
items do not cite. The October fixture has no journal entry, so
`october_on_project` still hits the observatory distilled sentence. Substring
matching uses those excerpts. A forbidden substring
anywhere in the returned package fails that question. `expect_truncated` must
match the package's `truncated` flag when the field is set. Questions without
`project` still call `search` with the question, area, k and a 64 KiB
budget. Substring matching against source or knowledge excerpts stays as
defined above.

The fictional corpus uses area `workshop` and projects `observatory`,
`notebook` and `lantern`. The October slice is three records in that area:

| Record | Project | What retrieval may return |
| --- | --- | --- |
| Distilled fact | observatory | `In October 2026 the observatory project shipped the cobalt mirror mount.` It cites the observatory pull request. |
| Observatory pull request | observatory | Archive body containing the distinctive phrase `diff hunk discussion`. Project search and a pack that already cites this source omit the body. |
| Distilled fact | notebook | `In October 2026 the notebook project renamed its index.` |

The loaded observatory profile section is purpose, then rules, then the text of
pinned decisions, 1400 bytes in all. A pack renders at most 20% of its budget
from that section (ADR 0015). The purpose `Track the fictional
observatory dome.` is inside the first 200 bytes. The pinned decision sentence
`Dome motors stay disabled until the shutter is confirmed closed.` begins after
byte 512 of the stored section. At 4096 it still fits in the profile share
after the oversized rules sentence is left out. At 512 the pack keeps the
purpose and does not reach that sentence. A recent approved fact says `The shutter sensor reports open or
closed.` and cites a long source whose excerpt contains `raw shutter wiring
dump`. A notebook decision says `The notebook project pins its index.` Those
pack records are dated outside October 2026, so they stay out of the month
question.

| Field | Accepted meaning |
| --- | --- |
| `project` | Project id. Required for these cases. |
| `since`, `until` | Inclusive / exclusive ISO timestamps, passed through to search. |
| `mode` | `pack` selects task-pack retrieval. Omitted means evidence search. |
| `budget_bytes` | Caller byte budget. Pack mode allows 512–65536. Evidence search passes it as `budgetBytes` (2048–65536). |
| `forbidden_substrings` | Literal case-sensitive phrases that must not appear in the returned package. |
| `expect_truncated` | When set, the run must report that truncation value. |

`october_on_project` asks what happened in October on the observatory project,
with `since` `2026-10-01T00:00:00Z` and `until` `2026-11-01T00:00:00Z`. The hit
is the observatory distilled sentence. `renamed its index` and
`diff hunk discussion` are forbidden.

`pack_for_task` asks `Add a shutter interlock to the dome` with
`budget_bytes: 4096`. The purpose, the pinned shutter decision and the sensor
fact are required. `raw shutter wiring dump` and `notebook project pins its
index` are forbidden.

`pack_budget` uses the same task and project with `budget_bytes: 512`. The
purpose is required, truncation is required, and the pinned decision sentence
and `raw shutter wiring dump` are forbidden.

`pack_proposed_decision` asks `Choose a chart timeframe and keep the saved
setting` on project `lantern` with `budget_bytes: 4096`. The expected sentence
is a proposed decision dated before eight newer unrelated lamp notes. It must
outrank `A chart legend uses blue.` `unrelated violet shade` and `таймфрейма`
are forbidden.

`pack_russian_task` asks `добавить новый таймфрейм на график` on the same
project. The expected sentence is the proposed decision `Выбор таймфрейма
сохраняет настройку графика.` It must outrank `Графика была обновлена в холле.`
`unrelated violet shade` and `chart timeframe choice` are forbidden.
