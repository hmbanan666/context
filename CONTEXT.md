# Context glossary

Context is a personal context engine for one owner and their authorized clients.
These terms describe the approved product direction; they do not imply that a
capability has shipped. Current capture/import paths share pattern-based secret
redaction; automatic understanding and hard delete remain targets. See the [spec](docs/spec.md) for requirements and stages.

## Language

**Owner**: The one person whose memory and access decisions this instance serves.
_Avoid_: tenant, team, account.

**Client**: An agent or application authorized by the owner to use Context with
specified rights.
_Avoid_: owner, provider, user (when referring to an agent).

**Area**: An owner-defined access boundary with separate read and write rights;
it is independent of a source's topics or project associations.
_Avoid_: scope (except OAuth scope or existing protocol fields), tag, folder, topic.

**Inbox**: The area for sources whose destination is not yet known, pending
sorting or an owner decision.
_Avoid_: personal (as a synonym), unrestricted area, miscellaneous topic.

**Source**: Raw input preserved immutably after secret redaction, with provenance;
it is evidence rather than an interpretation.
_Avoid_: fact, summary, unredacted original.

**Provenance**: The origin, client or import attribution, source reference and
timestamps that establish where a record came from.
_Avoid_: proof of truth, owner approval, topic.

**Understanding layer**: Derived, source-grounded knowledge about the owner,
including facts, decisions, projects and people.
_Avoid_: raw archive, unquestionable truth, approval ledger.

**Fact**: A source-grounded claim about the owner or their world, with its status
and history; it can be corrected or superseded. A distilled fact is one
self-contained sentence linked to its source, proposed until the owner approves it.
_Avoid_: source, immutable truth, approval.

**Decision**: A source-grounded choice whose status distinguishes a proposal
from an owner-approved choice. A distilled decision is one self-contained
sentence; inference does not approve it or supersede another item.
_Avoid_: suggestion (for an approved choice), inferred authorization, automatic supersession.

**Project**: An owner-defined undertaking in the understanding layer, with a
stable id and a display name. Sources and derived items may associate with
several projects. A project is independent of area: the area controls access,
the project says which undertaking the record belongs to. Association comes
from an owner `owner/repo` mapping or an optional `remember` field. A processor
proposal has no id that `remember` or `search` can use until the owner approves
it.
_Avoid_: area, permission, repository (as a universal synonym), the removed `project_context` tool.

**Project profile**: The small owner-written description of one project: purpose,
rules and pinned decisions in force. A task pack loads it for that project.
_Avoid_: area policy, inferred biography, raw archive.

**Journal**: A replaceable weekly summary of one project's distilled items. It
names the project and the week, groups decisions before facts, and cites those
items. It is not a decision, and it is not the deletion journal that holds tombstones.
_Avoid_: source, owner approval, a claim that the week is complete, deletion tombstone.

**Task pack**: A budgeted `search` result for one project and a task: the profile,
then decisions and facts ranked by that task, including proposed decisions, plus a
reserved share of matching raw sources.
_Avoid_: a separate tool, an unfiltered recent dump, a generated answer.

**Person**: Someone represented in the owner's context, with source-grounded
attributes and relationships.
_Avoid_: client, owner (unless it is the owner), login account.

**Superseding**: Replacement of a fact's current interpretation by a newer fact,
while retaining the older version in history.
_Avoid_: overwrite, hard delete, silent correction.

**History**: Retained previous versions and changes that explain how knowledge
evolved, subject to owner hard delete.
_Avoid_: current truth, undeletable archive.

**Hard delete**: Owner-directed removal of a record and all its derived items,
leaving only a deletion tombstone in the deletion journal.
_Avoid_: hide, archive, supersede, soft delete.

**Tombstone**: A minimal deletion-journal marker saying "deleted by owner", without the
deleted content or its derived knowledge.
_Avoid_: retained copy, summary of deleted content, undo record.

**Redaction**: Removal of secrets such as tokens, keys and passwords from input
before it becomes stored source content.
_Avoid_: display masking, encryption, post-storage cleanup.

**Import**: Ingestion of existing material from an external source with its
provenance and source-to-area mapping.
_Avoid_: synchronization (unless implemented), interpretation, work evidence.

**Processor**: The interchangeable interpreter that turns stored sources into
the understanding layer.
_Avoid_: client, embedding model, mandatory cloud provider.

**Embedding**: A derived representation of content used to find semantically
related material.
_Avoid_: fact, source, understanding layer.

**Eval set**: Questions with expected grounded outcomes used to measure Context's
quality; private real questions and public synthetic equivalents are distinct sets.
_Avoid_: production dump, public real benchmark, unit-test suite.

**Token**: A bearer credential authorizing a client's bounded access, subject to
revocation.
_Avoid_: password, passkey, source ID.

**Backup target**: The owner-configured off-host destination for recoverable
backup copies.
_Avoid_: same-host volume, live database, public archive.
