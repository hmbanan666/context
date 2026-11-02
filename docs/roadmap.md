# Roadmap

Owner-approved direction: **2 November 2026**. Context should be a simple box:
one container, set the owner password, connect an agent, save and retrieve memory.
The [spec](spec.md#stages-and-acceptance-criteria) defines target acceptance;
[architecture](architecture.md) records implemented behavior.

| Stage | Outcome | Current status |
| --- | --- | --- |
| 1 | Remove experiments; built-in OAuth/password/passkey/CLI tokens; nightly local and optional SFTP/S3 backups. | Merged. Owner reports ChatGPT connected; live off-host recovery remains unverified. |
| 2 | Headless clients, Grok Bot/Codex/GitHub imports and private/public evals. | JSONL imports and collectors merged (#26); eval harness and opt-in nightly eval merged and owner-confirmed deployed (#27). Private acceptance remains separate. |
| 3 | RU/EN morphology and local semantic retrieval with SQLite. | Merged and owner-confirmed deployed (#28); see [search](search.md). Hosted capacity and private acceptance remain separate. |
| 4 | Pluggable understanding, deduplication, superseding/history, hard delete, daily inbox sorting and broader quality acceptance. | Partially merged: nightly eval is merged; this PR adds nightly dedup, superseding/history, guarded inbox sorting and a compatible endpoint processor. Distilled per-topic knowledge, hard delete and private/live quality acceptance remain later steps. |
| 5 | Owner UI for search/inbox/delete/clients; ChatGPT export and Telegram imports. | Planned. |

The simplicity refactor preserves existing built-in OAuth connections, source
records, areas and client/token formats. The earlier Keycloak switch is historical;
this work requires no reconnect. Backups are plain SQLite over SSH/TLS; encryption
is out of scope. Keep setup small and distinguish merged code, tested behavior and
live acceptance. Every merge/deployment still needs separate owner approval.
Public fixtures remain synthetic; real eval questions and results remain private.
