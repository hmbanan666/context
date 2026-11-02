# Import existing material

Build once with `npm ci && npm run build`. There is one owner-local ingestion
command; collectors only produce JSONL and never open the Context database.
No new environment variables, services, model APIs or volumes are needed.

Inside the existing container, using its configured database and areas:

```sh
context import jsonl --source github --area projects --file /path/to/github.jsonl
context import jsonl --source codex --area projects < /path/to/codex.jsonl
context import jsonl --source grokbot --area personal < /path/to/grokbot.jsonl
```

`context` is `node dist/scripts/context.js`. `--file -` and an omitted `--file`
both read stdin. The existing `CONTEXT_DB_PATH` selects the database (production:
`/app/data/context.db`); `CONTEXT_AREAS` defines valid areas (production:
`personal,projects,inbox`). Local filesystem access is owner authority, as for the
backup CLI: imports do not need a network token, owner login or an OAuth setting.
There is no import HTTP endpoint. Run this command only with owner filesystem
access; agents use standard authenticated MCP for ordinary capture and retrieval.

## JSONL contract

UTF-8, one JSON object per line, LF or CRLF. A final newline is optional. Blank
lines, malformed UTF-8/JSON, unknown fields and invalid records are individually
rejected; the next line still runs. The maximum encoded line is **128 KiB**.
Limits below are JavaScript string lengths (UTF-16 code units).

| Field | Contract |
| --- | --- |
| `id` | Required nonblank stable external ID, up to 1024 characters, unique within `--source`; no control characters. IDs must not contain secrets. |
| `text` | Required nonblank original text, up to 8192 characters. Larger generic inputs are rejected; split them into stable IDs before import. |
| `title` | Optional nonblank title, up to 256 characters. |
| `created_at` | Optional ISO 8601 datetime with timezone, such as `2026-01-01T12:00:00Z`. Omit when the original time is unknown. |
| `area` | Optional nonblank area label, up to 80 characters. Overrides `--area`; see routing below. |
| `kind` | Optional nonblank label, up to 64 characters: e.g. `note`, `decision`, `pr`, `readme`, `adr`, `task-report`. This is attribution, never proof of owner approval. |
| `url` | Optional HTTP(S) source URL, up to 2048 characters, without embedded credentials. |
| `metadata` | Optional flat string map: at most 32 keys, keys 1–128 characters, values up to 2048 characters. No nested objects/arrays. |

Strings must be well-formed Unicode without NUL. `--source` is required, 1–64
ASCII letters/digits/dots/underscores/hyphens, beginning with a letter or digit.
Use the same source name on retries. It is attribution, not an access grant.

Routing uses the line's `area`, else `--area`, else `inbox`. A configured area is
accepted. Any unknown destination falls back to `inbox` **only if configured**;
otherwise that line is rejected. An unknown explicit line area does not fall back
to the CLI default. The CLI acts as the owner; MCP clients still require their
ordinary read/write area grants.

Synthetic Grok Bot export (the orchestrator supplies the real export privately):

```jsonl
{"id":"conversation:fictional-1","text":"The owner prefers a quiet reading room.","created_at":"2026-01-01T12:00:00Z","kind":"note","metadata":{"bot":"fictional-assistant"}}
{"id":"conversation:fictional-2","text":"The fictional observatory uses a blue telescope.","title":"Observatory note","area":"projects","kind":"note","url":"https://example.org/notes/2"}
```

Import with `--source grokbot --area personal`: the first record enters personal,
and the second enters projects if that area is configured.

## Preservation, retries and results

Secret redaction runs before source storage, metadata storage, checksums and retry
fingerprints. Both collectors use the same filter before emitting JSONL. It masks
recognizable GitHub/OpenAI/Anthropic/Slack/AWS access-key formats, JWTs, Bearer/Basic
credentials, PEM private-key blocks, common token/password/key assignments and URL
credentials. Secret-named metadata values are masked too. A secret-bearing identity
is rejected rather than transformed into a colliding ID. This is deterministic,
pattern-based redaction: arbitrary unlabeled secrets are not guaranteed detectable.
The existing MCP capture paths are unchanged and do not gain this filter here.

Each retained source has its own internal ID, checksum and capture timestamp.
`read_material` includes `import.source`, `import.externalId`, `import.kind` and
`import.metadata`; authored time and URL remain in `metadata.createdAt` and
`metadata.sourceUri`. Its `source.origin` is `import:<source-name>`. Existing
`recall`, `memory_context` and `context_package` find imports through the normal
source index. Read a package's original with `read_material` for full attribution.
All existing area checks apply, including when reading revision provenance.

A transaction saves the source, metadata, search entry and import identity together:

- First `(source, id)` version: `created`.
- Any already retained version: `skipped`, returning the same internal source ID.
- Different retained text, area, title, date, URL, kind or metadata under that
  `(source, id)`: **a new immutable source revision**, reported as `changed` with
  its new internal source ID. Revisions are linked by the same `import.source`
  and `import.externalId`. Nothing is overwritten or removed.
- Invalid/unsaved line: `rejected` with a fixed reason; no input text is echoed.

Comparison is of the redacted representation; metadata key order does not matter.
Retrying an older file after a newer revision skips its already retained versions.
All revisions remain searchable evidence; this slice does not choose a current
interpretation, merge revisions or infer superseding decisions. A changed area
stores the new revision in that area; the older revision retains its original area.

Stdout is JSONL, one result per physical input line, then a summary. External IDs,
URLs, metadata, text and raw errors are never echoed in results:

```jsonl
{"type":"item","line":1,"status":"created","source_id":"example-internal-id"}
{"type":"item","line":2,"status":"rejected","reason":"invalid_item"}
{"type":"summary","created":1,"skipped":0,"changed":0,"rejected":1}
```

Exit `0`: all records saved/revised or skipped. Exit `2`: one or more rejected
lines; valid lines are already committed. Exit `1`: fatal arguments/configuration/
input/output failure, with a fixed JSON error on stderr; the run may be partial
and have no summary. Correct invalid lines or retry `storage_failure_retryable`
results. Interrupted runs are safe to replay in full, including after concurrent
imports. SQLite uses short per-record transactions with a five-second busy timeout.

## GitHub collector (operator machine)

Requires Node and an installed, authenticated `gh`; it uses `gh api` against
`github.com`. Existing `gh` login or `GH_TOKEN`/`GITHUB_TOKEN` works. Credentials
never appear in arguments or output. Access needs repository contents and pull
requests read permission. No token is needed inside Context for the import.

```sh
umask 077
node dist/scripts/collect-github.js --owner fictional-owner > github.jsonl
node dist/scripts/collect-github.js --owner fictional-owner --repos observatory,notebook --since 2026-01-01T00:00:00Z > github.jsonl
```

Default enumeration combines public owner repos with accessible private repos from
the authenticated account, deduplicated by full name. `--repos` limits collection
to comma-separated repository names under the owner. Archived repos and forks are
skipped unless `--include-archived` / `--include-forks` is supplied.

Collected from each readable repository:

- README and `.md`, `.txt`, `.rst` files in the root, `docs/` and `docs/adr/` on the
  default branch. No general recursive crawl. Skip files over 256 KiB; retained
  text is redacted then truncated to 8192 characters, marked in metadata.
- All merged PR titles and bodies, with merge time, number and URL. `--since`
  applies inclusively to **merge time**, not file modification times. PRs are
  paginated; unmerged closed PRs, comments, reviews, diffs and tool output are absent.

IDs: `github:<owner>/<repo>:pr:<number>` and
`github:<owner>/<repo>:file:<path>@<blob-sha>`. File blobs are fetched by SHA so
content matches identity even if the branch moves. A changed blob gets a new
external ID; an edited PR body becomes a revision under the same PR ID. Files have
no invented authored timestamp. All output defaults to area `projects`.

Requests are sequential, bounded to an 8 MiB response and 30-second timeout.
Directories hitting the GitHub contents API's 1000-entry cap report an error rather
than claim complete coverage. Per-repo/item failures increment error counts and
other readable repos continue; rate/network failures can be retried by rerunning.
See the official [gh api](https://cli.github.com/manual/gh_api),
[contents](https://docs.github.com/en/rest/repos/contents#get-repository-content) and
[pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) docs.

## Codex and task-runner collector (operator machine)

```sh
umask 077
node dist/scripts/collect-codex.js --sessions ~/.codex/sessions --tasks ~/tasks > codex.jsonl
```

`--sessions` defaults to `~/.codex/sessions`; `--tasks` is optional. Session JSONL
files are traversed recursively without following symlinks. The parser supports
local `session_meta`, `response_item` messages with `phase: final_answer` (also
`final` / `channel: final`), and older `event_msg/task_complete.last_agent_message`.
It selects the first actual user prompt and last explicit final answer, skipping
AGENTS/environment bootstrap messages. It does not import later user prompts,
intermediate assistant commentary, tools, tool outputs, reasoning or compaction
summaries. Sessions lacking a prompt or final answer are skipped.

Session metadata retains available cwd/repository, session start time and final
message timestamp. Stable ID: `codex:<session-id>`. Each `tasks/<id>/prompt.txt`
and `last.md` pair becomes `codex-task:<id>`. Missing/empty reports are skipped;
task timestamps are filesystem modification times, explicitly marked
`timestamp_basis: file_mtime`. Task files alone do not supply a reliable repo/cwd.
Both kinds use area `projects` and kind `task-report`.

Prompt and final answer are redacted independently and limited to 3900 characters
each, with explicit truncation markers/metadata. Task file reads cap at 1 MiB each;
rollout lines cap at 8 MiB. Invalid/oversized rollout lines are ignored, never copied
as raw source text. No plugins, Codex process or inference provider is started.
Rerun after a session finishes or changes to retain a new final-answer revision.

Collectors emit JSONL only on stdout and count/byte summaries on stderr. Exit `0`
means collection completed (intentional skips may remain), `2` means partial item/
repository errors, `1` means a fatal failure. Keep the JSONL private, import it,
inspect the counts and delete the temporary export when no longer needed. Imports
stream one bounded line at a time; collectors keep one bounded response/session
record at a time. No archive is loaded into memory in full. Existing SQLite and
backup volumes suffice; no runtime memory-limit change is required by design.

## Verification and release

Synthetic tests cover redaction before persistence, retries and immutable revisions,
area fallback/denial, reopen and MCP retrieval, malformed/oversized lines, collector
selection, pagination and partial failures. Run `npm run check` before release.
Real collector checks report only counts and bytes; real exports, private repo
contents and memory never belong in this repository or public PR text.

The additive `source_imports` table/index is created on database open and is part
of ordinary SQLite backups. No existing source is rewritten. Deploy only after
owner approval, then run imports inside the existing container. Container execution,
live production import, hosted-client save/reopen/ask and private eval acceptance
must be verified separately; local collector success does not establish them.
