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

**Sprint 2: synthetic hosted acceptance closed on 27 October 2026.**
PR #4 is merged and the service runs at `context.kosarev.space` with Keycloak,
HTTPS and dedicated storage. Hosted OAuth, actual Codex CLI login, SDK
capture/recall across redeploy and database recovery checks passed. The owner
confirmed ChatGPT capture followed by Codex recall; a connected Codex tool also
retrieved that original synthetic record on 27 October 2026. After separate
approval, that exact record survived actual container recreation on `dfd0331`
and an offline restore into a separate file. Source equality, checksum, FTS,
retry identity and scope denial passed; the original live database was retained.
See [deployment](docs/deployment.md) for evidence, configuration and remaining
acceptance evidence and remaining operational limitations. Real private-memory
ingestion remains unapproved.

**Sprint 3: implemented and tested in separate reviewable changes.** Source
materials, grounded knowledge, signed owner review, durable local subscription
processing and project context/access are implemented. They are not yet merged
or deployed. An actual local subscription job completed; hosted model execution
and its credential lifecycle remain unverified.

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
the same command, builds the image and runs the Keycloak smoke on PRs and pushes
to `main`. After changing source, run
`npm run build` before `npm start` or `npm run seed:synthetic`.

No cloud account, API key or LLM is required. MCP uses the official TypeScript
SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/node`) and Zod.
The SDK client is a development dependency for integration tests.
SQLite uses Node's built-in `node:sqlite` module (currently release-candidate
stability; an experimental warning may appear). See the
[Node SQLite reference](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).

### Configuration

Export environment variables in your shell; `.env.example` documents defaults
but the service does not load `.env` automatically.

| Variable          | Default             | Meaning                                                                                                |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`        | `development`       | `production` requires a complete protected OAuth configuration; unknown modes fail closed. |
| `CONTEXT_PORT`    | `3000`              | Integer 0–65535; 0 requests a free local port, printed at startup.                                     |
| `CONTEXT_DB_PATH` | `./data/context.db` | Persistent SQLite file, relative to the working directory or absolute. Parent directories are created. |
| `CONTEXT_LOCAL_MCP` | unset | Set exactly `synthetic` to enable the local no-auth MCP experiment. Otherwise `/mcp` returns 404. |
| `CONTEXT_LOCAL_SCOPES` | `synthetic:local-foundation` when MCP is enabled | Comma-separated list of 1–8 distinct permitted synthetic scopes. Requires explicit MCP opt-in. |

The local no-auth listener is fixed to `127.0.0.1`; do not expose it through a
proxy or tunnel. Protected OAuth mode binds the container interface and requires
the exact approved HTTPS resource/issuer and owner subject. See the deployment
guide before using that mode. Logs contain listener metadata or generic errors,
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
checks that incomplete production configuration creates neither a listener nor a database.
The smoke test also uses a fresh official MCP client against each service
process: it captures, recalls, searches and retries the same source after a real
process restart, with unchanged ID, timestamp, text and checksum. Temporary files
are removed. This proves local MCP persistence, not a ChatGPT roundtrip.

The optional `npm run seed:synthetic` command writes the same public fixture
to the configured local database and safely repeats without overwriting it.
The source store supports insert-only records, scoped exact lookup and SQLite
FTS5 phrase search. Startup upgrades Sprint 0 databases additively and indexes
existing sources without changing their original content. HTTP source REST
routes `/capture`, `/recall` and `/sources` do not exist.

### Local MCP experiment

```sh
CONTEXT_LOCAL_MCP=synthetic npm start
```

The Streamable HTTP endpoint is `http://127.0.0.1:3000/mcp`. Without this opt-in,
only health is exposed. This is intentionally an isolated **no-auth, synthetic
test mode**: all local clients share the configured scope grants. A client cannot
grant itself scopes through tool arguments or headers. This mode does not verify
a person's identity and must never be used for real private data. Requests with
an Authorization header are rejected rather than treating a token as verified.
The service validates Host and Origin and rejects request bodies over 64 KiB.

Both tools require `version: 1` and one configured `synthetic:` scope (maximum
80 characters; lowercase letters/digits/colon/underscore/hyphen). Successful
results and application errors carry `version: 1`, machine-readable
`structuredContent` and equivalent JSON text. SDK input-validation errors use
the standard MCP tool-error response.

- `capture`: `text` (1–8192 UTF-16 code units), `origin` (1–256), and
  `idempotencyKey` (1–128 ASCII letters/digits/period/underscore/colon/hyphen).
  Returns `source` and `duplicate`. Source includes server-generated UUID and UTC
  timestamp, original text/origin/scope, UTF-8 SHA-256 checksum, and `unreviewed`
  status. Approval/status claims and unknown fields are rejected.
- `recall`: exactly one of `id` (1–128 identifier characters) or `query` (1–256),
  plus optional `limit` (1–20, default 10). Returns `sources`. Queries are literal
  FTS phrases, not SQL or FTS expressions; punctuation-only queries may match
  nothing. Exact lookup outside the requested scope returns `not_found`.

Text, origin and query must be nonblank, well-formed Unicode without NUL
characters. Malformed input is rejected before storage or consuming its key.

Idempotency is persistent and scoped: repeating the same key and exact
text/origin/scope/version returns the original source and `duplicate: true`,
including after restart. Reusing it with different input returns
`idempotency_conflict`. Source and request key commit in one SQLite transaction;
failed writes leave neither a source nor an index entry. Idempotency keys have
no expiry in this experiment. Unconfigured scopes return `forbidden_scope`
before lookup/write. Storage failures return a generic `storage_unavailable`.

### Source materials

The additive material tools preserve the existing `capture`/`recall` v1
contract. `capture_material` accepts the same fields as `capture`, plus optional
`metadata`: `type` (`note` or `document`), `title`, `createdAt` (ISO timestamp),
and `sourceUri` (HTTP(S) URL without credentials). Metadata is immutable and
participates in retry identity. `createdAt` describes the source; `capturedAt`
remains the server's receipt timestamp. URLs are recorded, never fetched.

`capture_file` accepts `version`, `scope`, `origin`, `idempotencyKey`, a simple
`.txt`/`.md` `filename`, matching `mediaType` (`text/plain`/`text/markdown`),
canonical `contentBase64`, and optional metadata. Files must contain nonblank,
valid UTF-8 and fit within 16 KiB. Original bytes, including BOM and line
endings, are stored as SQLite BLOBs in the same transaction as the source,
metadata, FTS entry and request key. SQLite snapshots therefore contain the
complete material without a separate blob-volume recovery procedure.

`read_material` and `read_file` require `version`, `scope` and `id`. The former
returns source/metadata/file descriptor; the latter returns original bytes as
base64 after checksum verification. All four tools enforce the same operation
and data-scope grants as capture/recall. Existing sources receive a conservative
`note` material view without rewriting their original records. Request keys are
shared across capture tools; using a key for a different operation conflicts.
Only synthetic materials are authorized. PDF, audio, images, URL fetching and
automatic interpretation are outside this slice.

### Structured knowledge and owner review

`add_knowledge` records `idea`, `observation` or `decision_proposal` items with
immutable creation metadata and 1–8 source references. Every source must exist
in the same scope; supplied quotes must be exact source substrings. Creator
fields describe an untrusted attribution claim. All new items are `suggested`,
including those attributed to a user. `read_knowledge` accepts an optional `id`
or returns a bounded recent list. `relate_knowledge` records suggested
`supports`, `contradicts` or `supersedes` links with their own provenance.
`read_relations` and `knowledge_history` retrieve scoped links and append-only
review evidence. A suggested supersedes link cannot alter decision status.

Approval is deliberately outside MCP. An owner-controlled Ed25519 key signs a
receipt containing `review` (`version`, `scope`, `id`, `idempotencyKey`, `status`,
`evidence`) and a canonical base64 `signature`. `ownerReviewPayload` in
`src/owner-review.ts` defines the exact domain-separated bytes to sign. The
trusted public key must be selected by the operator independently of the
receipt; the private signing key must remain outside Context and agent access.

```sh
npm run build
npm run knowledge:review -- ./data/context.db /private/path/owner-public.pem /private/path/signed-review.json
```

Valid receipts append `reviewed`, `rejected` or `approved` events, including the
original signed receipt and public-key fingerprint. Only decision proposals can
be approved. Invalid signatures and tampering create no event; identical replay
is idempotent. Original knowledge and previous reviews remain retrievable.
Signature verification proves possession of the trusted signing key; operating
that key as a human approval boundary remains the owner's responsibility.
No real owner key has been provisioned by this implementation.

### Subscription-backed processing

`queue_processing` queues an existing same-scope source using `version`, `scope`,
`sourceId` and `idempotencyKey`; it requires source read, write and explicit
processing permission.
`processing_status` reads one job by optional `id` or a bounded recent list.
MCP never starts a model process and never returns lease credentials or raw
model output. Jobs and retry keys are part of the same SQLite backup.

An operator can process the local synthetic database with an existing ChatGPT
Codex login:

```sh
codex login
npm run build
npm run memory:process -- ./data/context.db synthetic:local-foundation --once
```

`--drain` handles at most 20 eligible jobs and does not wait for retry delays.
The command reports only job IDs/statuses and exits unsuccessfully if an
attempt fails. It is an explicit local operator command, separate from the
HTTP service. The Docker image does not include Codex or subscription
credentials; hosted model processing has not been demonstrated.

The adapter requires the actually probed `codex-cli 0.164.0`, an existing
ChatGPT login, strict configuration and disabled shell, MCP, browser, plugins,
agents and code-mode execution. It removes API-key overrides and has no paid
API fallback. Inputs go through stdin, with a schema-only private temporary
directory, a 90-second timeout and a 1 MiB output limit. Unknown CLI versions,
tool events, incomplete streams or unrecognized events fail closed. The CLI's
known code-mode-disabled startup diagnostic is accepted; it is not treated as
a tool capability. This is a version-specific integration, not a guarantee for
future CLI releases.

Before deriving knowledge, the worker persists schema-valid output whose
quotes match the original source. Leases exclude simultaneous workers; stale
workers cannot complete a job. Three attempts use bounded backoff. Restarts
replay saved output with stable per-item keys, including after partial writes,
so a repeated model paraphrase cannot create duplicate results. All generated
knowledge remains `suggested` and carries processor version `memory-v1`.

On 27 October 2026 an actual local synthetic job completed through this
adapter: two grounded items, unchanged original and persistent retry identity.
Repeated standalone subscription probes also completed. Token-refresh
recovery, sustained quota behavior and remote subscription processing remain
unverified. Current official guidance: [authentication](https://learn.chatgpt.com/docs/auth),
[noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
and [configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

### Project context and access

`project_context` accepts `version`, one synthetic `scope`, optional `limit`
(1–20, default 10) and `maxBytes` (1024–65536, default 16384). The complete JSON
context payload is bounded in UTF-8 bytes; MCP's duplicated transport framing
is separate. Items include all cited original materials, even when those are
older than the recent-source list. Relations require both endpoints and all
cited sources. Oversized or unavailable evidence omits the entire derived
entry and sets `truncated`; text and quotes are never silently shortened.
Original file bytes are excluded; authorized callers can use `read_file`.

In OAuth mode, `CONTEXT_CLIENT_GRANTS` is an explicit operator-controlled JSON
map for the existing `context-chatgpt` and `context-codex` clients. Each entry
requires `read`, `write` and `process` arrays of distinct synthetic data scopes.
Every operation requires both a verified signed token's operation/data scopes
and the corresponding server grant. Unknown/missing clients in an explicit map
have no access; request fields cannot change grants. Invalid configuration
fails before a listener or database opens. Without the map, the original pilot
read/write policy remains and processing is denied.

Queueing additionally requires `context:process` and an explicit process grant,
alongside read/write. Local no-auth tests remain isolated synthetic experiments
whose scopes come only from configuration. This is a single-owner pilot with
client-specific access, not a multi-user permissions service.

See `.env.example` for a synthetic grant map and
[deployment](docs/deployment.md) for the explicit project override and Keycloak
scope setup. Realm imports do not update an already deployed realm. Activating
new hosted scopes and model processing requires their own verified setup.

Run the independent MCP Inspector CLI smoke check:

```sh
npm run inspect:smoke
```

It downloads pinned Inspector **2.12.0** through `npx` on first use (network
access required), starts a temporary synthetic instance on a free loopback port,
checks tool discovery in modern and legacy protocol eras, captures and retries,
then restarts the service and verifies exact recall and FTS with new Inspector
clients. It uses a temporary client configuration and removes its test database.
This optional interoperability check is separate from the offline `npm run check`
suite after dependencies are installed.

To inspect a running local instance manually:

```sh
npx --yes @modelcontextprotocol/inspector@2.12.0 --cli \
  --server-url http://127.0.0.1:3000/mcp --transport http \
  --protocol-era modern --method tools/list
```

The implementation follows the official
[SDK HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md).
Protected deployment configuration and Keycloak protocol checks are documented
separately in [deployment](docs/deployment.md). Actual hosted synthetic
ChatGPT/Codex roundtrip is confirmed; per-record live recovery has separate
acceptance evidence. These synthetic tests do not authorize private ingestion.

## Hosting

The intended host for later testing is an existing **Dokploy** installation,
as an independent application with its own persistent storage and a separately
approved HTTPS service hostname. The Dokploy administrative panel is **not**
the MCP endpoint and must not be treated as an OAuth provider.

## License

MIT.
