# Architecture decision records

Accepted decisions for Context. The spec and roadmap say what has shipped.
A later ADR narrows an earlier one only where this index says so.

| ADR | Status | Decision | Narrowed by |
| --- | --- | --- | --- |
| [0001](0001-built-in-authorization.md) | Accepted | Built-in OAuth, passkeys and CLI tokens replace a separate identity service. | none |
| [0002](0002-areas-and-inbox.md) | Accepted | An area is an access boundary; inbox holds unknown destinations. | [0010](0010-projects-in-the-understanding-layer.md) — a project is not an area, and association is not access |
| [0003](0003-sources-and-understanding.md) | Accepted | Keep redacted sources, and derive revisable facts, decisions, projects and people. | [0011](0011-distill-proposed-facts-and-decisions.md) — supersession is explicit `remember` with `supersedes`; a new fact does not replace the old one by itself |
| [0004](0004-sqlite-and-local-search.md) | Accepted | Keep SQLite and add local morphological and semantic search. | [0014](0014-cross-lingual-project-search.md) — the local model is multilingual E5 small; vectors carry that id |
| [0005](0005-pluggable-processor.md) | Accepted | Use an explicitly configured OpenAI-compatible processor, or opt-in Codex. | [0011](0011-distill-proposed-facts-and-decisions.md) — distillation uses that processor and adds no provider, SDK or environment variable |
| [0006](0006-eval-driven-quality.md) | Accepted | Measure with a private eval set and public synthetic equivalents. | [0012](0012-project-profile-journal-and-task-pack.md) — project-memory acceptance uses the synthetic cases named there; [0014](0014-cross-lingual-project-search.md) adds a per-project Russian set |
| [0007](0007-single-owner-open-source.md) | Accepted | One MIT self-hosted engine for one owner. | none |
| [0008](0008-remove-experiments.md) | Accepted | Remove signatures, work evidence, synthetic scopes and `project_context`. | [0010](0010-projects-in-the-understanding-layer.md), [0012](0012-project-profile-journal-and-task-pack.md) — `project_context` stays removed; projects are catalog entities and `search` fields |
| [0009](0009-nightly-off-host-backups.md) | Accepted | Nightly SQLite backups with an optional off-host SFTP or S3 copy. | none |
| [0010](0010-projects-in-the-understanding-layer.md) | Accepted | Projects are understanding-layer entities with configured, client and proposed associations. | [0011](0011-distill-proposed-facts-and-decisions.md) stores processor proposals; [0012](0012-project-profile-journal-and-task-pack.md) adds profile, journal and pack on the catalog |
| [0011](0011-distill-proposed-facts-and-decisions.md) | Accepted | Nightly tidy distills short proposed facts and decisions and never writes supersession. | none |
| [0012](0012-project-profile-journal-and-task-pack.md) | Accepted | Load one project's profile, journal and budgeted task pack through `search`. | [0013](0013-rank-the-task-pack-by-the-query.md) — pack ranking, the relevance floor, and the source share |
| [0013](0013-rank-the-task-pack-by-the-query.md) | Accepted | Rank a task pack by the query, including proposed decisions, and reserve room for sources. | [0014](0014-cross-lingual-project-search.md) — glossary hits rank in bands below original terms when the query expands |
| [0014](0014-cross-lingual-project-search.md) | Accepted | Keep multilingual E5 small, tag vectors with that id, and expand a project glossary into FTS. | none |
