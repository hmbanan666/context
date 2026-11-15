# Documents are versioned sources

Status: Accepted

Date: 2026-11-15

## Context

An architect agent needs to store an ADR or a spec on a project and later read
the current text by a stable key, including the older revisions. Context
already keeps immutable source revisions for markdown import. MCP stays
`search`, `remember`, `read` and `timeline`.

Owner approval of distilled facts and decisions stays on `context project
review`. A document status is not that approval.

## Decision

A document is a source with `doc`: `type` (`adr`, `spec` or `note`), `key`,
`title` and `status`. The key is unique for one project and one type. It is
1–64 characters: a letter or digit, then letters, digits, `.`, `_`, `:` or
`-`. `adr:0012` and `hybrid-rank` are both keys. The read id is
`doc:<project>:<type>:<key>`. `@<revision>` reads an older revision, starting
at 1. The result lists every revision in that area: revision, source id,
status, title, who set it, and capture time.

`remember` takes an optional `doc` object and one project. A project-bound
token supplies that project when the argument is omitted. Each new write
appends a revision. The same idempotency key and the same payload return the
existing revision. ADR status is `proposed`, `accepted`, `superseded` or
`rejected`. Spec status is `draft`, `active` or `obsolete`. A note's status is
`active`. Any write token may set any of those, including `accepted`. The
token's name is stored as `setBy`. An import stores `import`.

`search` leaves older revisions out. `kind: "doc"` returns only current
documents. `docType` is `adr`, `spec` or `note` and implies that filter. An
accepted ADR or an active spec scores one point above an equal match, so a
task pack can still place it in the two source slots. A superseded, rejected
or obsolete document scores half and stays readable. Other rows are unchanged.
Pack mode does not take `kind` or `docType`.

`context import markdown` copies front matter `type`, `key` and `status` onto
those fields. `title` is the existing title. The relative path remains the
import key. A changed body, title or status writes the next revision. A second
file with the same project, type and key is rejected. A document that does not
fit in one source is rejected. Quoting a numeric key keeps leading zeros.

## Consequences

Architects read and write project ADRs and specs through the four tools. A
document status does not approve a distilled decision, pin a profile or change
area rights. Search no longer returns an older revision of the same key.
Markdown files without those front-matter fields import as they do today.
