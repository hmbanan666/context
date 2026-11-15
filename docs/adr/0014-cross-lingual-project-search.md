# Cross-lingual project search uses multilingual E5 small and a glossary

Status: Accepted

Date: 2026-11-15

## Context

A Russian task on the live `context` project, in pack mode, did not surface the
distillation decision (ADR 0011) or the nightly tidy notes. It surfaced backup
decisions instead. FTS is lexical, so "дистилляция" does not hit "distill", and
"tidy" is not a translation of that word at all. The embedding model already in
the image is `intfloat/multilingual-e5-small` (Xenova ONNX, q8, 384 dimensions).
It is multilingual and still weak on short cross-lingual queries. ADR 0004 leaves
the model choice to measurement. ADR 0013 fuses exact FTS, stems and vectors with
vector weight 5, which was calibrated for this model at cosine 0.80.

## Decision

**Model.** Stay on `Xenova/multilingual-e5-small` revision
`761b726dd34fb83930e26aab4e9ac3899aa1fa78`, q8, mean pooling, 384 dimensions.
`multilingual-e5-base` was the other candidate. Its quantized ONNX file is
278,647,662 bytes and 768 dimensions; small is 118,308,185 bytes. The published
small-model load is about 2 seconds and about 500 MiB RSS, with a short embed
around 14 ms. Base is about 2.4 times the parameters, so latency would still fit
the 2 second query budget, and RSS would land nearer 700–800 MiB. Compose allows
1536 MiB. `context reindex --embeddings` loads a second copy beside the server.
Two small models fit. Two base models do not, with the eval CLI as a third copy
worse. The 0.80 cosine floor was calibrated on the private corpus for this small
model. Changing the model without that corpus would invalidate the floor.
`query: ` and `passage: ` prefixes, including the space, stay on every call.

Every stored vector keeps that model id (`model` on `embedding_chunks`, the full
version string). Search compares a query vector only to chunks with the same id
and the same width. Other ids are reported as `embeddings_mixed` and are not
scored. `context reindex --embeddings [--batch N]` loads the local model, queues
rows that lack a current-id vector, embeds them in batches, and prints counts,
the model id and any other ids. It does not print source text. A failed row is
retried immediately, up to the existing three attempts. Rows that already have
the current id are skipped, so a rerun is safe. A live lease held by the server
is left alone until it expires (ten minutes).

**Glossary.** Each project stores bilingual terms beside its profile, not inside
the 2048-byte profile document. The owner edits them with
`context project glossary set|show|unset`. A term is one token. It has 1–8
synonym tokens. A project holds at most 32 terms. A project entry replaces the
built-in entry with the same stem. The built-in list is a small generic RU→EN
developer vocabulary (backup, distill, nightly, embedding, deploy, and the like).
It does not include project slang such as tidy. Search and pack expand query
tokens through that list before FTS. The embedding query stays the original
question. Timeline is unchanged.

Expanded concepts are their own FTS lists at weight 0.35. Original exact and
stemmed lists stay at weight 1. Synonyms that share a stem count as one concept.
At most 24 expanded tokens are added. When the query did expand, an original-term
hit is placed in a higher rank band than any synonym hit, and a hit on two or
more synonym concepts is placed above a vector neighbour that matched only one.
A single synonym stays on ordinary reciprocal-rank fusion, so one broad word
cannot flood past an original hit or a paraphrase. Queries that match no glossary
entry keep today's vector weight of 5.

**Project eval.** `context eval projects` reads a questions file (default
`evals/projects.yaml` beside the database, override with `--questions`) and
reports per-project recall@k and pack-hit rate. k is 1–20, default 10. The file
uses the existing eval question schema, plus `item_id` for a knowledge item.
Public CI runs `fixtures/evals/projects.yaml`: 12 Russian questions each for the
fictional projects `context` and `expi`, including "улучшить ночную дистилляцию".
A private prod file is the same shape with real ids or substrings and stays out
of git. Results append to `projects-history.jsonl` with ids and metrics, not
question text. Misses exit 0. An isolation violation exits 2.

`tools/list` remains `search`, `remember`, `read` and `timeline`.

## Consequences

This upgrade does not replace vectors that already carry the small-model id.
Run `context reindex --embeddings` after deploy to confirm `otherModels` is
empty; on a current database that command loads the model and then finds nothing
to redo. A later model change re-embeds only because the id will not match.
Prod still needs the owner to add project slang (`tidy` for дистилляция on
`context`). The synthetic expi glossary is not written into production.
Pack and project search change order only for queries that hit the glossary.
Area-wide search uses the built-in list the same way. The private 34-question
hybrid numbers in the search doc were measured without this glossary and are
not re-run here.

Amended by [ADR 0015](0015-pack-profile-share-and-glossary-phrases.md): a term
may be a phrase of up to four words, matched by stem plus one fleeting vowel,
and the public expi set has one more pack question.
