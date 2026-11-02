# Roadmap

Owner-approved direction: **2 November 2026**. The pilot is running; stage 1 is
in progress. These stages supersede the earlier sprint plans and stop statements.
The [product spec](spec.md#stages-and-acceptance-criteria) defines acceptance;
[current architecture](architecture.md) distinguishes shipped behavior from targets.

| Stage | Outcome | Status |
| --- | --- | --- |
| 1 | Cleanup and self-contained operation: **1a** remove experiments; **1b** replace Keycloak and its PostgreSQL DB with built-in OAuth 2.1 AS, DCR, PKCE, password + passkey and CLI tokens; **1c** nightly backup with configurable SFTP/S3-compatible off-host copy. | In progress; three PR-sized slices, not yet shipped. |
| 2 | Connect Grok Bot and server Codex; import Grok Bot transcripts, Codex sessions and GitHub PRs; establish private 20–30-question eval set and synthetic public equivalents, run after each change. | Planned |
| 3 | Russian/English morphology and local semantic embeddings with SQLite; no paid embedding API. | Planned |
| 4 | Pluggable understanding layer, deduplication, superseding/history, hard delete, daily inbox sorting and nightly evals. | Planned |
| 5 | Core owner UI for search, inbox decisions, delete and clients/tokens; ChatGPT export import and Telegram. | Planned |

Stage 1b requires existing ChatGPT/Codex connections to reconnect. Until it ships,
the current pilot remains on Keycloak. The one-command `docker run` product is a
target, not the current quick start. This docs-only PR records direction and
completes no implementation slice.

Implement small, testable PRs with source-grounded acceptance evidence. Every
merge and deployment requires separate explicit owner approval. Public fixtures
stay synthetic; the real eval set stays private. Historical plans and release
evidence remain in Git history and PR records.
