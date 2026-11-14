# Distill sources into short proposed facts and decisions

Status: Accepted

Date: 2026-11-14

## Context

A project question needs a sentence of what changed. Search instead returns raw
pull-request bodies until the byte limit, and those bodies are the wrong shape
of memory. ADR 0005 already selects the processor. Automatic tidy supersession
was removed after owner-reported live precision of 3/12 and stays removed:
replacing a whole note can hide claims that are still valid.

## Decision

Nightly tidy uses the configured processor from ADR 0005. That is the existing
OpenAI-compatible chat-completions endpoint (for example OpenRouter with the
model the owner configures) or opt-in Codex. No new provider, SDK or environment
variable is introduced. When no processor is configured, distillation does not
run.

For each source revision that has no distilled item yet, tidy derives items
with:

- kind `fact` or `decision`
- one self-contained sentence of at most 400 characters. When the source
  already has a configured or client project link, the item inherits that
  link and the sentence does not have to contain the project id. Product
  names such as "Unbored Companion" or "Kosarev Space" stay as the source
  writes them. When the source has no such link and the model proposes a
  project, the sentence must name that project; case and hyphens, spaces or
  no separator do not matter. An unmapped source with no proposal stays
  unlinked
- associations copied from configured and client links; a model-supplied id of
  an existing project that is not already linked is stored as a proposed
  association. Any other project string is a proposed project with that
  suggested name and no usable id (ADR 0010)
- date from the source authored time, otherwise the capture time. A numeric
  offset such as `+01:00` is accepted and the knowledge row stores that
  instant in UTC with a `Z` suffix. The source metadata keeps the original
  timestamp
- a link to the immutable source id, and the source URL when one is stored
- status `proposed`

The processor cannot set `approved`, write a `supersedes` link, or change the
source. A later revision gets its own proposed item. The older item remains
until a client passes `supersedes` on `remember`. A conflict is at most another
proposed fact.

Each call covers at most 8 sources. Each nightly run makes at most 12
distillation calls, counted apart from inbox sorting, and resumes from a cursor
on the next run. The prompt for each source is its title, known project ids,
URL, date, kind and at most 1500 characters of body. Capture does not wait for
a call.

GitHub pull requests stay stored as raw archive evidence. The stored sentence
states what was decided or shipped. A mapped source keeps its project on the
item even when the sentence uses the product name instead of the id.
A sentence that copies a contiguous 80-character span of stored prose is
rejected and the source stays pending. The span is measured after code spans,
identifiers, ADR titles, URLs and markdown marks are removed and whitespace is
collapsed, so those tokens do not by themselves reject a short sentence. A
real 80-character prose copy is still rejected. Invalid model output skips that source
and does not write a partial item. Requests send redacted stored text only and
keep the timeouts and skip-on-failure behavior in ADR 0005.

## Consequences

Hundreds of new imports can take several nights to distill. Until an item
exists, retrieval still sees the raw source. A distilled sentence is not owner
approval and is not a substitute for the source. People extraction, hard delete
and any automatic supersede stay out of this decision. Live precision is
unmeasured until the synthetic and private evals for this work have been run.
