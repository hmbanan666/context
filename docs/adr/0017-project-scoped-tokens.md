# A token may be bound to one project

Status: Accepted

Date: 2026-11-15

## Context

ADR 0010 makes a project an understanding-layer entity. Association does not
grant access, and an area remains the access boundary from ADR 0002. ADR 0007
keeps one owner per instance. Those decisions stay.

A token that can read an area can still search, list and read every project in
that area. `tools/list` hides the old tool names, but `tools/call` still runs
them, so a client can bypass the four-tool surface. `search` and `read` also
default `scope` to `personal` even when the token's only area is different.

## Decision

This amends ADR 0010 only by adding an optional project binding on a token. It
does not change ADR 0007. The instance remains one owner. A project is still
not an area, and a record's association still does not grant access.

A token may name at most one project id. The id uses the same character rules
as an area and is 1–64 characters. The token must still have at least one read
or write area. The binding is stored on that credential. Existing tokens have
no project field; they stay area-scoped. No stored row is rewritten.

`context token create` accepts `--project <id>` together with `--read` and
`--write`. The id must already exist. OAuth registration, consent and refresh
stay area-only: the consent screen does not offer a project, and an OAuth
access token has no project binding.

For a project-bound token:

- `search` and `timeline` use that project. Omitting `project` applies it. A
  different `project` argument is rejected.
- `search` with `listProjects: true` returns that project only.
- `read` returns a source, knowledge item or profile only when it is linked to
  that project. Anything else is `not_found`.
- `remember` stores the source under that project. A `project` list that names
  any other id is rejected. Omitting `project` still tags the bound project.

An area token, with no project binding, keeps optional `project` filters. Its
`listProjects` result is not the whole catalog. It includes a project whose
home area is one of the token's read areas, or that has a linked source or
knowledge item in one of those areas. A repository mapping alone does not
publish a project into an area the token cannot read. Local no-auth mode is
the owner on one machine and still lists the catalog.

When a token has exactly one read area, `search`, `read` and `timeline`
default `scope` to that area. When it has exactly one write area, `remember`
defaults `scope` to that area. Several areas keep today's defaults: `personal`
for reads, and the credential's default write area for `remember`.

`tools/call` accepts only `search`, `remember`, `read` and `timeline`. Any
other name, including the hidden legacy tools, returns `unknown_tool` and does
not run. `tools/list` is unchanged.

## Consequences

Amended by [ADR 0020](0020-client-written-knowledge.md): `mayApprove` is a
separate boolean on the credential, default off, and is not part of OAuth
consent. A project binding still limits which project the token can write.

A project-bound token cannot see or write another project's records through
MCP. An area token can still see every project that lives in, or has linked
records in, its read areas. OAuth clients stay area-scoped until a later
decision adds a project to consent. Project deletion remains undefined. People
remain a separate understanding-layer entity.
