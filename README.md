# Context

**Experimental, self-hosted continuity engine for ideas, decisions and verified work.**

Context is not another messenger, general note-taking application, or autonomous
coding system. It is a small shared memory service for existing clients
(ChatGPT, Codex, and later others), intended to preserve the *reasons* for work,
not just a transcript or a list of tickets.

## Hypothesis

A user discusses an idea in their usual chat and explicitly requests
"capture this". A separate agent can later retrieve the authorized, grounded
context, turn an approved intention into work, and link the result back to
source material and verifiable evidence.

This repository contains open-source code and synthetic fixtures only.
**Do not commit real conversations, personal notes, manuscripts, documents,
uploads, credentials, tokens, or instance databases.**

## First meaningful end-to-end test

1. Save a synthetic note via the Context MCP `capture` tool in ChatGPT.
2. Verify that the original content, source, status and stable ID are persisted.
3. Retrieve that record using `recall` from a fresh Codex session.
4. Verify the same record survives process restart and is inaccessible outside
   its authorized scope.
5. Record exactly which parts have been demonstrated and which are still blocked.

No autonomous agents, RAG, Mastra, visual graph, or UI is necessary for this
first proof of usefulness.

## System boundaries

- **Capture first:** persist raw sources; AI interpretation is derived.
- **Decisions are explicit:** brainstorming, proposals, owner approval,
  implementation, PR, merge, and deployment are separate states.
- **Provenance is mandatory:** any derived observation refers to source IDs.
- **Portable access:** MCP offers narrow tools to authorized clients.
- **Private instance, public code:** repository does not contain personal data.
- **Subscription-first:** no paid LLM API requirements without owner approval.
- **Independent project:** do not merge this codebase with Dostigus,
  kosarev.space, K39, Woodlands or the private book project.

Architecture: [docs/architecture.md](docs/architecture.md)  
Milestones and acceptance: [docs/roadmap.md](docs/roadmap.md)  
Deployment: [docs/deployment.md](docs/deployment.md)  
Agent instructions: [AGENTS.md](AGENTS.md)

## Status

**Sprint 0: local TypeScript service and SQLite foundation. Nothing is deployed.**
The service exposes only a loopback health endpoint. MCP capture/recall, remote
authentication and plugin interoperability belong to later approved milestones
and have not been implemented or demonstrated.

## Local development

Use Node **24.22.1** and npm **11.19.1**, pinned in `.nvmrc` and `package.json`.
With [nvm](https://github.com/nvm-sh/nvm) installed:

```sh
nvm install
nvm use
npm install --global npm@11.19.1
npm ci
npm run check
npm run seed:synthetic
npm start
```

In another terminal:

```sh
curl --fail http://127.0.0.1:3000/health
```

Expected response: `{"status":"ok"}`. Stop with Ctrl-C. `npm run check` runs
lint/format checks, type checking, compilation and all tests; GitHub CI runs
the same command on PRs and pushes to `main`. After changing source, run
`npm run build` before `npm start` or `npm run seed:synthetic`.

No cloud account, API key, LLM or runtime package dependency is required.
SQLite uses Node's built-in `node:sqlite` module (currently release-candidate
stability; an experimental warning may appear). See the
[Node SQLite reference](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).

### Configuration

Export environment variables in your shell; `.env.example` documents defaults
but the service does not load `.env` automatically.

| Variable          | Default             | Meaning                                                                                                |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`        | `development`       | Only `development` and `test` are supported. Other modes fail before opening the database or listener. |
| `CONTEXT_PORT`    | `3000`              | Integer 0–65535; 0 requests a free local port, printed at startup.                                     |
| `CONTEXT_DB_PATH` | `./data/context.db` | Persistent SQLite file, relative to the working directory or absolute. Parent directories are created. |

The listener is fixed to `127.0.0.1`; there is no public bind option. Do not
expose this milestone through a proxy or tunnel. Production authentication
has not been implemented. Logs contain listener metadata or generic errors,
never source records. Database files, WAL files and environment files are ignored
by Git. Use synthetic data only, including in local databases.

### Persistence proof

```sh
npm run test:smoke
```

This test creates a temporary database, seeds a deterministic synthetic source,
starts and stops the actual compiled service, repeats seed/start/stop, then
checks the original text, provenance, scope, timestamp, SHA-256 checksum and
`unreviewed` status through the internal store after each shutdown. It also
checks that production mode creates neither a listener nor a database.
Temporary files are removed. This proves local persistence; it does not prove
an MCP client or ChatGPT roundtrip.

The optional `npm run seed:synthetic` command writes the same public fixture
to the configured local database and safely repeats without overwriting it.
The internal source store supports insert-only records and scoped exact lookup;
scope arguments are not caller authentication. No source read/write routes are
exposed: `/mcp`, `/capture`, `/recall` and `/sources` return 404.

Sprint 0 stops here for code and test-environment review before remote access.

## Hosting

The intended host for later testing is an existing **Dokploy** installation,
as an independent application with its own persistent storage and a separately
approved HTTPS service hostname. The Dokploy administrative panel is **not**
the MCP endpoint and must not be treated as an OAuth provider.

## License

MIT.
