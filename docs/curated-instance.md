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
may set `title`, `project`, `date`, and `tags`. Details and limits are in
[Imports](imports.md).

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

## When to say "I don't know"

Every `search` result includes `grounding`: `strong`, `weak`, or `none`.
It is computed from the query's own content words and, when embeddings exist,
from cosine on `multilingual-e5-small`. It is not the rank of the first card.
A page can be the nearest stored page and still be `none`.

Instruct the agent:

- `none`: say you don't know. Do not answer from a merely similar page.
- `weak`: answer only from the cited text, and say the overlap is partial.
- `strong`: answer from the cited text.

Thresholds have defaults (`0.5` of the content words, cosine `0.84` / `0.92`)
and can be set with `CONTEXT_GROUNDING_LEXICAL_STRONG`,
`CONTEXT_GROUNDING_COSINE_WEAK`, and `CONTEXT_GROUNDING_COSINE_STRONG`.
See [Search](search.md#grounding).

Check a checkout with the fictional corpus:

```sh
pnpm run eval:grounding
```

The target is at least 9 of 10 off-topic questions at `none`, and at least
9 of 10 on-topic questions not `none` and pointing at the right file.
The script always runs lexical search. It also runs semantic search when
`models/Xenova/multilingual-e5-small` is present, and says when that model
is unavailable.
