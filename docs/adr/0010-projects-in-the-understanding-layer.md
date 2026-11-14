# Projects are understanding-layer entities

Status: Accepted

Date: 2026-11-14

## Context

On 14 November 2026 a month-scoped MCP search over the area `projects` returned
raw pull-request fragments from five undertakings, no derived items, and stopped
at the package byte limit. That area held 432 October sources, mostly unreviewed
GitHub imports, with no project association. ADR 0002 makes an area an access
boundary, not a topic. ADR 0003 already names projects as understanding-layer
entities. ADR 0008 removed the experimental `project_context` tool; that tool
was an unfiltered recent projection and stays removed.

## Decision

A project is an owner-defined understanding-layer entity with a stable id and a
display name. The id is 1–64 characters, matching the area character rules, and
does not change when the name changes. A project has one home area, which
controls who may read its profile. A project is not an area, a permission or a
repository. The same string may be used as an area name and as a project id
without sharing meaning.

A source or derived item may associate with zero or more projects. Association
never grants read or write rights. Records stay in their own area. A client
sees an association only when it can read that record's area, and sees a
profile only when it can read the project's home area.

Associations record an origin:

- **Configured.** The owner maps a repository full name (`owner/repo`) to one
  existing project. GitHub import applies the mapping from import metadata.
  Any other import applies it when its metadata carries that repository name.
  Unmapped sources stay unassociated; a repository does not become a project by
  itself. An explicit backfill replaces configured-origin associations on
  sources and on their distilled items from the current mapping and import
  metadata. Client and proposed associations stay as stored. Later imports use
  the mapping current at import time. The mapping is durable instance state in
  the existing SQLite database. It does not approve claims in the source.
- **Client.** `remember` accepts an optional `project` field: 1–8 distinct ids
  of existing projects. The saved source is associated with those projects.
  Unknown ids are rejected. Omitting the field leaves the source unassociated.
  This is attribution, not approval of a decision.
- **Proposed.** The processor may propose a link to an existing project, or a
  new project as a suggested name plus the source id. A proposal has no id that
  `remember` or `search` can use until the owner approves it and assigns one.
  Proposals do not change default retrieval.

No MCP tool is added. `search` and `timeline` accept an optional `project` id
and then return only records associated with that project; omitting it preserves
today's area-wide behavior. `read` returns each association's project id, origin
and status. `search` accepts `listProjects: true` and then returns at most 64
projects as id and name, ordered by id, with `truncated` when more exist. That
call does not run retrieval. Setting it together with `query` or `project` is
rejected. The default is false. Owner catalog, mappings, backfill and approval
are CLI operations on the same trust boundary as import.

## Consequences

Clients that omit `project` still search a mixed area and can still fill the
byte budget with unrelated raw sources. The catalog is empty until the owner
creates projects and mappings. Proposed projects and the removed
`project_context` tool are not substitutes for that catalog. These decisions do
not define project deletion. People remain a separate understanding-layer entity.
