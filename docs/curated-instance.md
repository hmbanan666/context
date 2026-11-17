# Curated instance

One Context instance can be a website assistant: cases, a resume, services,
and contacts. It stores those pages and answers only from them. It does not
need an LLM. The public tools stay `search`, `remember`, `read`, and
`timeline`. A read-only token never calls `remember`.

This is a separate trust boundary from a personal memory box. Use its own
volume and `CONTEXT_PUBLIC_URL`. Do not point it at an existing personal
database.

## Stand up

Follow [Quick start](QUICKSTART.md) through compose and `context init`. Leave
the LLM lines commented so the processor stays off. Set `CONTEXT_AREAS` to
the one area this assistant may read, for example `studio`.

Create the project the pages belong to, then import a folder of markdown.
The folder in `fixtures/curated/mira-quill` is a fictional specialist and is
safe to try:

```sh
docker compose exec context context project create \
  --id mira --name "Mira Quill" --home studio
docker compose exec context context import markdown /notes \
  --area studio --project mira
```

Mount or copy the folder into the container first. On a local checkout,
after `pnpm run build`:

```sh
context project create --id mira --name "Mira Quill" --home studio
context import markdown fixtures/curated/mira-quill --area studio --project mira
```

`CONTEXT_DB_PATH` and `CONTEXT_AREAS` select the database and the legal
areas. Import does not need `CONTEXT_PUBLIC_URL`. The command walks `*.md`
recursively. The relative path is the stable key. Optional YAML front matter
may set `title`, `project`, `date`, and `tags`. `type`, `key` and `status`
mark an ADR, spec or note. Details and limits are in [Imports](imports.md).

Running the import again skips unchanged files and writes a new revision for
files that changed. The summary reports `added`, `updated`, `skipped`, and
`removed`. `removed` stays `0` unless you pass `--prune`.

A file deleted from the folder stays searchable until that opt-in re-sync:

```sh
context import markdown fixtures/curated/mira-quill \
  --area studio --project mira --prune
```

`--prune` retires markdown sources from that same area, project, and import
directory whose relative path is no longer in the folder. It does not retire
sources that have no recorded import root. `--prune-legacy` opts into those
older rows. An empty directory is refused unless you pass `--force`. A missing
path is refused either way, and nothing is retired. The source row stays
in the database and drops out of search, timeline, and read. Importing the
file again makes it visible. `context doc restore <id>` or
`context source restore <source id>` undoes a retirement without a re-import.
To retire one document or one source without a
folder walk, the owner runs `context doc remove doc:mira:adr:0012` or
`context doc remove <source id>`. Those commands are not MCP tools.

Leave the LLM lines commented out. `/health` then reports `"processor": "off"`.
`embeddings` is `warming` while the model loads after listen, `ready` after
that startup embed, and `off` when no model is available. The listen event
stays on stdout. The ready line is `{"event":"embeddings_ready"}` on stderr.
That is a supported mode: distillation does not run, and startup logs that
once. It is not a failed configuration. When a processor is configured the
field is `openai` or `codex`, with no model name and no key.

Embeddings are queued the same way as any other capture. The running server
indexes them in the background. `context reindex --embeddings` does the same
job in the foreground. No model call is required for import or for lexical
search.

## Read-only token

`context init` prints an admin token that can write. The website assistant
gets a different token with read and no write:

```sh
docker compose exec context context token create website --read studio
```

Omit `--write` and `--default-write`. The token still needs
`CONTEXT_PUBLIC_URL`, like any other token. Add `--project mira` when this
client should see only that project. The secret prints once. Put it in the
client's `Authorization` header the same way as the [quick start](QUICKSTART.md).

`remember` then returns an authorization error. `search`, `read`, and
`timeline` stay available.

## ADRs and specs

A project folder can include architecture notes the assistant should quote.
Add front matter and import the folder with the same command:

```yaml
---
type: adr
key: "0012"
status: accepted
title: Keep the amber index
---
```

`type` is `adr`, `spec` or `note`. ADR status is `proposed`, `accepted`,
`superseded` or `rejected`. Spec status is `draft`, `active` or `obsolete`.
The relative path is still the import key. Importing the file again after an
edit stores the next revision. Read the current text with
`doc:<project>:<type>:<key>`, or `@1` for the first revision. Search returns
the current revision only. An accepted ADR or an active spec ranks above an
equal superseded document. The read-only token can search and read these; it
cannot write a new revision. A write token uses `remember` with `doc` instead
of a fifth tool. See [ADR 0018](adr/0018-documents-are-versioned-sources.md).

## When to say "I don't know"

Every `search` result includes `grounding`: `strong`, `weak`, or `none`.
It is computed from uncommon query terms that co-occur in one passage and,
when embeddings exist, from the margin of that passage over the area or
project centroid. Common words in a large corpus do not make a result
strong. The result is `none` when the uncommon share is below `0.30` and,
if embeddings exist, the margin is below the weak floor. That includes a
rare term that covers only a small part of the query. It is not the rank
of the first card. A page can be the nearest stored page and still be
`none`.

Instruct the agent:

- `none`: say you don't know. Do not answer from a merely similar page.
  Pass `whenNone: "empty"` to receive no cards in that case. Set
  `CONTEXT_SEARCH_WHEN_NONE=empty` when this instance should do that for
  every search. The default is `keep`, which still returns the cards and
  the `none` label. When cards are omitted the result includes
  `cardsOmitted: "grounding-none"`.
- `weak`: answer only from the cited text, and say the overlap is partial.
- `strong`: answer from the cited text.

When `items` is empty and the processor is off, the result includes
`itemsHint`: `Items are empty because the processor is off.` That is not an
error. Sources are still searchable.

On a scoped corpus smaller than 6 records
(`CONTEXT_GROUNDING_MARGIN_MIN_CORPUS`), the centroid is too close to the
passage itself, so the margin is skipped and the lexical-only rules apply.
An exact match can then be `strong`, and an off-topic query stays `none`.
Question words (how, what, где, чём, and the same kind of function word)
do not count against that share, and the stored title is part of the first
passage window, so an English paraphrase of an English paragraph and a
question that repeats the title can be `strong`. On that same small corpus,
source cards below half the best card's match score are omitted
(`CONTEXT_SEARCH_CARD_FLOOR`, default `0.5`, `0` disables it). A larger
corpus does not use that floor and keeps the margin. Thresholds have defaults (uncommon share `0.5`, or `0.75` with no embeddings;
share below `0.30` is the none floor; a term is common from corpus size
`40`, document frequency `8`, and rate `0.05`; margin `0.024` / `0.08`;
margin corpus floor `6`) and
can be set with
`CONTEXT_GROUNDING_LEXICAL_STRONG`,
`CONTEXT_GROUNDING_LEXICAL_NONE`,
`CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG`,
`CONTEXT_GROUNDING_COMMON_CORPUS`,
`CONTEXT_GROUNDING_COMMON_MIN_DF`,
`CONTEXT_GROUNDING_COMMON_RATE`,
`CONTEXT_GROUNDING_MARGIN_WEAK`,
`CONTEXT_GROUNDING_MARGIN_STRONG`, and
`CONTEXT_GROUNDING_MARGIN_MIN_CORPUS`.
`CONTEXT_SEARCH_CARD_FLOOR` defaults to `0.5`.
Calibrate the margin on a real database with
`context grounding explain --file`. See [Search](search.md#grounding).

To inspect labels on a database that stays on this machine:

```sh
context grounding explain --query "where is the lantern" --area studio
context grounding explain --file questions.yaml --area studio
```

The file is a list of `query`, optional `project`, and `expect: on` or
`off`. A question's `project` overrides `--project`. The report prints the
features and, for a file, the margin distributions and the cuts that
separate on-topic from off-topic. It does not change thresholds.

Check a checkout with the fictional corpus and a few hundred synthetic
distractor notes:

```sh
pnpm run eval:grounding
```

On the curated notes alone, the target is at least 9 of 10 off-topic
questions at `none`, and at least 9 of 10 on-topic questions not `none`
and pointing at the right file. On the mixed corpus, off-topic questions
that share ordinary words with the distractors must be `none` or at most
`weak` for at least 9 of 10, and on-topic questions must still be not
`none` for at least 9 of 10 and point at the right file. The script always
runs lexical search. It also runs semantic search when
`models/Xenova/multilingual-e5-small` or
`.output/models/Xenova/multilingual-e5-small` is present, and says when
that model is unavailable.
