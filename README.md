# Context

An [MIT](LICENSE) open-source personal context engine for **one owner** and their
AI agents. Context preserves sources and provenance so authorized clients can
remember and answer across conversations and providers through MCP.

**Status: pilot running; stage 1 in progress. Stage 1a is done in this PR,
not yet merged or deployed.** The approved direction is a
self-hosted black box, started with one `docker run` command, with built-in OAuth,
local semantic search, a source-grounded understanding layer and an owner web UI.
Those are staged targets. Today's protected pilot still uses Keycloak and its
PostgreSQL database; the one-command product setup is not yet available.

The cleaned-up core provides `remember`, paged `memory_context` and
bounded `context_package` retrieval over SQLite originals and existing knowledge.
Search is lexical; morphology, local embeddings and unattended understanding are
not yet delivered. Changing AI clients should preserve the owner's memory.

## Quick start today: local synthetic development

Use Node **24.22.1** and npm **11.19.1** (pinned in `.nvmrc` and `package.json`).
With nvm installed:

```sh
nvm install
nvm use
npm install --global npm@11.19.1
npm ci
npm run check
CONTEXT_LOCAL_MCP=enabled npm start
```

The local synthetic MCP endpoint is `http://127.0.0.1:3000/mcp`. In another terminal:

```sh
curl --fail http://127.0.0.1:3000/health
```

Expected: `{"status":"ok"}`. Stop with Ctrl-C. Without `CONTEXT_LOCAL_MCP=enabled`,
only health is exposed. This loopback-only no-auth mode is for fictional data;
never expose it remotely or use it for private memory. No model or API key is
needed. `npm run check` builds the code; rebuild after source changes.

Defaults: port `3000`, SQLite `./data/context.db`, area `personal`. Configure areas
with `CONTEXT_AREAS`; OAuth requires explicit `CONTEXT_CLIENT_GRANTS` as well as
signed operation/area scopes. Export configuration variables
in the shell; [`.env.example`](.env.example) is reference, not an auto-loaded file.
Protected configuration is still specific to the existing pilot; see
[deployment](docs/deployment.md) before attempting a protected setup.

## Direction and current behavior

- [Product spec and staged acceptance](docs/spec.md)
- [Glossary](CONTEXT.md) and [accepted decisions](docs/adr/)
- [Roadmap](docs/roadmap.md)
- [Current architecture](docs/architecture.md) and [deployment](docs/deployment.md)
- [Agent instructions](AGENTS.md)

This public repository contains **synthetic fixtures only**. Keep real notes,
private eval questions and outputs, credentials and backups outside Git.
Merges and deployments require separate explicit owner approval.
