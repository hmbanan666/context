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
| 4 | Pluggable understanding, deduplication, superseding/history, hard delete, daily inbox sorting and broader quality acceptance. | Partially merged: nightly eval, dedup, explicit client supersession/history and guarded inbox sorting with Codex or an OpenAI-compatible processor. Slices 4a–4e are merged. Owner reports 4a–4d and the footer/distill spread fix are deployed. A follow-up for date-window recall, journal summaries, rejection counters and footer body text is the next change. Slice 4f is not started. Hard delete and private/live quality acceptance remain later steps. |
| 5 | Owner UI for search/inbox/delete/clients; ChatGPT export and Telegram imports. | Planned. |

The simplicity refactor preserves existing built-in OAuth connections, source
records, areas and client/token formats. The earlier Keycloak switch is historical;
this work requires no reconnect. Backups are plain SQLite over SSH/TLS; encryption
is out of scope. Keep setup small and distinguish merged code, tested behavior and
live acceptance. Every merge/deployment still needs separate owner approval.
Public fixtures remain synthetic; real eval questions and results remain private.

Automatic tidy supersession is removed after owner-reported live precision of
3/12 proposals: superseding multi-claim notes can hide still-valid claims.
Clients use `remember` with `supersedes` explicitly; tidy retains deterministic
dedup and batched inbox sorting with a call cap. Distillation must not write
supersedes links.

### Stage 4 project-memory slices

Each slice is a later PR. Merging or deploying one still needs separate owner
approval. ADRs 0010–0012 are the contract; these rows are the order.

| Slice | PR | Acceptance for that PR |
| --- | --- | --- |
| 4a | Implemented, not deployed. Project catalog and association. Owner CLI for project id, name, home area and `owner/repo` mappings. Import and an explicit backfill write configured associations. Optional `project` on `remember`, `search` and `timeline`. `read` returns associations. `search` `listProjects: true` returns the bounded catalog. | Synthetic two-repository import into one area. A project filter returns one project. Omitting the filter still returns both. A client without read access to a record's area does not see that association. Unknown `remember` project ids are rejected. No processor calls. |
| 4b | Implemented, not deployed. Nightly distillation (ADR 0011) on the configured processor, with a fake model in tests. | A GitHub-style fixture stores one meaning sentence and rejects an 80-character body copy. No supersedes row is written. A claimed `approved` status is not in force. The call cap resumes from a cursor. An unconfigured processor skips. Sources and checksums stay unchanged. |
| 4c | Implemented, not deployed. Project search prefers distilled items and omits cited raw sources. | The public October case passes. The other project's sentence and the raw body phrase are absent. Search without `project` stays area-wide. |
| 4d | Implemented, not deployed. Owner CLI profile (purpose, rules, up to eight pinned decision ids, 2048 UTF-8 bytes) and a deterministic weekly journal in nightly tidy. | A profile over 2048 bytes is rejected. The processor cannot write the profile. A journal cites only that week's distilled items, and a week with none has no entry. |
| 4e | Implemented, not deployed. Owner CLI `context project review` lists proposed facts, decisions, processor project proposals and proposed profile pins by project, kind and date, and approves or rejects them by id or by project and ISO week. | A proposed decision is absent from decisions in force. After approval it is present. `remember` with `supersedes` remains the only way to supersede. |
| 4f | `search` mode `pack`. | The public pack cases pass. `tools/list` still shows four tools. Omitting `mode` keeps today's evidence search. |

Follow-up after the 4a–4d deploy, not a new slice: project search with a project
id and `since` or `until` includes that window's journals, decisions and facts
even when the query shares no words, ranked journals then decisions then facts.
A weekly journal is a short summary of that week's decisions then facts, at most
800 characters, in the source language. `context tidy --journal-backfill` writes
older weeks that have items, at most 24 per run (`--journal-backfill-limit`, max
52), and a later run does not rewrite an unchanged week. Tidy JSON includes
`distillRejections`. A few redacted samples go to stderr, not tidy history.
Search keeps prose before and after a Cursor pull-request footer and rebuilds
the derived source index once.

4d and 4e both depend on 4b and can land in either order. 4f depends on 4c, 4d
and 4e. 4c depends on 4b. 4b depends on 4a. Private questions for the same
journeys stay in the owner's private eval file after the public cases exist.
