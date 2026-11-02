# Context

An [MIT](LICENSE) open-source personal context engine for **one owner** and their
AI agents. Context preserves sources and provenance so authorized clients can
remember and answer across conversations and providers through MCP.

**Status: stage 1a merged; stage 1b implementation done in PR #23, not yet
merged or deployed.** The core now provides built-in OAuth 2.1, password + passkey
owner login and CLI bearer tokens without Keycloak or its PostgreSQL database.
Existing Keycloak connections must reconnect after the switch. The pilot's last
recorded release remains unchanged; this PR does not inspect or migrate it.
The approved one-command black box, local semantic search, understanding layer
and full owner web UI remain staged targets; see [deployment](docs/deployment.md).

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
with `CONTEXT_AREAS`. Protected mode uses `CONTEXT_AUTH=oauth` and a public HTTPS
`CONTEXT_PUBLIC_URL` ending in `/mcp`; client grants live in SQLite. Initialize
with `npm run context -- owner init`, then connect through standard MCP OAuth or
issue a CLI token. Protected `remember` uses the credential's default write area.
Export variables in the shell; [`.env.example`](.env.example) is reference, not an
auto-loaded file. See [deployment](docs/deployment.md#current-protected-setup) for
setup, supported clients, token management and the reconnect migration.

## Direction and current behavior

- [Product spec and staged acceptance](docs/spec.md)
- [Glossary](CONTEXT.md) and [accepted decisions](docs/adr/)
- [Roadmap](docs/roadmap.md)
- [Current architecture](docs/architecture.md) and [deployment](docs/deployment.md)
- [Agent instructions](AGENTS.md)

This public repository contains **synthetic fixtures only**. Keep real notes,
private eval questions and outputs, credentials and backups outside Git.
Merges and deployments require separate explicit owner approval.
