# remember creates a missing project

Status: Accepted

Date: 2026-11-21

## Context

ADR 0010 says `remember` accepts 1–8 ids of existing projects and rejects
unknown ids. ADR 0017 lets an area token pass those ids and makes a
project-bound token reject any other id. Creating a project is a CLI step.
A host that writes on first use has no CLI step, and creating a project must
not be the default for every write token.

## Decision

This amends the client-origin rule in ADR 0010 and the area-token rule in
ADR 0017. No MCP tool is added. `search`, `read` and `timeline` still reject
an unknown project id. `context remember` still requires an existing id.

`context token create` accepts `--create-projects`. The capability is stored
on that credential and `token list` shows `createProjects`. It defaults to
off. Existing tokens stay off. It cannot be combined with `--project`. OAuth
consent does not offer it, and an OAuth access token never creates a project.

MCP `remember` creates a missing project only when the caller is local
no-auth owner mode, or an area CLI token with `createProjects` and write
access on the target area. Any other caller keeps today's rejection. A
project-bound token still rejects any other id. A token that cannot write
the area is rejected. Nothing is created in those cases.

The id must match the existing project id rules: 1–64 characters and the
same charset as an area. An invalid id is an input error. Nothing is created
and the source is not stored.

The created project's id is the given id. Its name is optional `projectName`
when the call names one project, otherwise the id. `projectName` is ignored
when that project already exists. A name with any other number of ids is an
input error. The home area is the area the source is written to. The insert
and the source share one transaction. `projectCreated` is true only when
this call inserted a project. Two concurrent remembers with the same new id
create one project.

## Consequences

A client can open a project on first write only when the owner opted that
token in, or when the owner is using local no-auth mode. OAuth clients and
ordinary area tokens still need `context project create`. The owner can
rename a project later. Project deletion remains undefined.
