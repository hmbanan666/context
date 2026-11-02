# Context glossary

Context is a personal context engine for one owner and their authorized clients.
These terms describe the approved product direction; they do not imply that a
capability has shipped. See the [spec](docs/spec.md) for requirements and stages.

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
and history; it can be corrected or superseded.
_Avoid_: source, immutable truth, approval.

**Decision**: A source-grounded choice whose status distinguishes a proposal
from an owner-approved choice.
_Avoid_: suggestion (for an approved choice), inferred authorization.

**Project**: An undertaking represented in the understanding layer, potentially
associated with multiple sources.
_Avoid_: area, permission, repository (as a universal synonym).

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
leaving only a deletion tombstone in the journal.
_Avoid_: hide, archive, supersede, soft delete.

**Tombstone**: A minimal journal marker saying "deleted by owner", without the
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
