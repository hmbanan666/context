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
files that changed. The summary reports `added`, `updated`, and `skipped`.
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
when embeddings exist, from the cosine of that passage. Common words in a
large corpus do not make a result strong. It is not the rank of the first
card. A page can be the nearest stored page and still be `none`.

Instruct the agent:

- `none`: say you don't know. Do not answer from a merely similar page.
- `weak`: answer only from the cited text, and say the overlap is partial.
- `strong`: answer from the cited text.

Thresholds have defaults (uncommon share `0.5`, or `0.75` with no embeddings;
a term is common from corpus size `40`, document frequency `8`, and rate
`0.05`; cosine `0.84` / `0.92`) and can be set with
`CONTEXT_GROUNDING_LEXICAL_STRONG`,
`CONTEXT_GROUNDING_LEXICAL_ONLY_STRONG`,
`CONTEXT_GROUNDING_COMMON_CORPUS`,
`CONTEXT_GROUNDING_COMMON_MIN_DF`,
`CONTEXT_GROUNDING_COMMON_RATE`,
`CONTEXT_GROUNDING_COSINE_WEAK`, and
`CONTEXT_GROUNDING_COSINE_STRONG`.
See [Search](search.md#grounding).

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
