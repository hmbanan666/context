# A client may write a fact, a decision, and a project profile

Status: Accepted

Date: 2026-11-21

## Context

A client needs a grill outcome in `search` with `mode: "pack"` on the same turn
it is saved. Nightly distillation is too late, and a fifth MCP tool would add
schema text to every client turn. ADR 0011 leaves the sentence to the processor
and stores it as `proposed`. ADR 0012 keeps the profile on the owner CLI and
builds the weekly journal from facts and decisions without another model call.
ADR 0017 binds a token to one project, and every write token has the same
authority inside that project.

## Decision

This amends ADR 0011, ADR 0012, and ADR 0017. `tools/list` stays `search`,
`remember`, `read`, and `timeline`. No new tool. Token capabilities are
separate booleans on the credential. `mayApprove` is one. `createProjects`
from ADR 0019 is another. Neither lives inside the other.

**Statement.** `remember` accepts `metadata.kind` of `fact` or `decision`. The
text is one statement of at most 400 characters. A longer text or a line break
is rejected and nothing is stored. Context stores the source, then writes a
knowledge item in the same transaction: the same kind, status `proposed`, the
source's project links, `createdAt` from the source time, and `sourceLinks` to
that source. `metadata.supersedes` lists one to eight knowledge item ids. Each
target is a fact or decision in the write area. When the write names projects,
the target is linked to each of those projects. A project-bound token cannot
name another project. The new item supersedes the targets.

The processor treats a source that already has a fact or decision, and a source
recorded as a profile write, as already processed. It still cannot approve, set
`supersedes`, or write a profile. The language check on a distilled sentence
does not apply to a client-written item. The text is stored as given. Search
and pack show the knowledge item immediately. Timeline shows the stored source.
The weekly journal keeps that sentence on the next pass, including when the
sentence is in another language than the distilled items. This decision does
not add a journal generator.

**Approval.** `context token create` accepts `--may-approve`. The flag is off
unless it is set, OAuth consent does not offer it, and `context token list`
shows it. A token with the flag may pass `metadata.status: "approved"` on the
same statement. The review row stores `setBy` as the token name, and the token
id when the credential has one. Any other token that passes `approved` is
rejected and nothing is stored. There is no silent downgrade. The processor
still never approves. Local no-auth mode is the owner on one machine and may
approve.

**Profile.** `remember` with `doc.type: "profile"`, one project, `doc.title` as
the purpose, `text` as the rules, and optional `doc.pins` (up to eight decision
ids in that project) overwrites that project's profile. `doc.key` is accepted
so the object matches a document, and it does not create a second profile. The
stored document is purpose, rules, and pins joined by newlines, at most 2048
UTF-8 bytes, the same limit as `context project profile set`. Only a
`mayApprove` token, or local owner mode, may set it. The write records `setBy`
and does not append document revisions. A project-bound token cannot set
another project's profile or pin another project's decision.

## Consequences

A client can put a decision in the pack on the same turn. Approval is an
explicit capability, not a side effect of write access. A statement without a
project is still stored and appears in timeline. Project search and pack show
it when it is linked to that project. The journal still waits for the existing
tidy or backfill pass. A profile write is an overwrite of the one profile, not
a revision history.
