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
- one self-contained sentence of at most 400 characters, naming its project
  when a configured or client association exists
- associations copied from configured and client links; a model-supplied id of
  an existing project that is not already linked is stored as a proposed
  association. Any other project string is a proposed project with that
  suggested name and no usable id (ADR 0010)
- date from the source authored time, otherwise the capture time
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
states what was decided or shipped and names the project when one is known.
A sentence that copies a contiguous 80-character span of the stored body is
rejected and the source stays pending. Invalid model output skips that source
and does not write a partial item. Requests send redacted stored text only and
keep the timeouts and skip-on-failure behavior in ADR 0005.

## Consequences

Hundreds of new imports can take several nights to distill. Until an item
exists, retrieval still sees the raw source. A distilled sentence is not owner
approval and is not a substitute for the source. People extraction, hard delete
and any automatic supersede stay out of this decision. Live precision is
unmeasured until the synthetic and private evals for this work have been run.
