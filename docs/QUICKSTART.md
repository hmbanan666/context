# Quick start

One Context instance is one trust boundary: a person, a company, or one
website assistant. This page stands up a new instance from the published
image and connects an MCP client. The client sees four tools: `search`,
`remember`, `read`, and `timeline`.

An existing Traefik or Dokploy install stays on
[deploy/compose.yaml](../deploy/compose.yaml) and
[deploy/dokploy.yaml](../deploy/dokploy.yaml). Do not point that volume at
this file.

## Install

The image is `ghcr.io/hmbanan666/context`, tagged with the git commit and
`latest`. GitHub's runner publishes `linux/amd64`. The embedding model is
already in the image.

The first push creates a private package. Anonymous `docker pull` works
after the package is public. That switch is once, in the
[package settings](https://github.com/users/hmbanan666/packages/container/package/context),
and it cannot be undone. GitHub provides no API for it, so CI cannot flip it.

```sh
cp .env.example .env
# Set CONTEXT_PUBLIC_URL to this instance's public HTTPS URL ending in /mcp.
docker compose up -d
```

`compose.yaml` publishes port 3000 on `127.0.0.1` only and stores the
database and local backups in the `context-data` volume. Forward the public
hostname to that port, including `/mcp`, `/auth/*`, `/oauth/*`, and
`/.well-known/*`, and keep the Host header. The URL's hostname has to match.
`CONTEXT_AREAS` defaults to `personal`. Leave the LLM lines commented: the
processor stays off.

## Initialize

```sh
docker compose exec context context init
```

To create the first project and bind the token to it:

```sh
docker compose exec context context init --project notes --name "Notes"
```

The project id is lowercase letters, digits, and `:_-`. Its home area is the
first configured area (`personal` unless you changed `CONTEXT_AREAS`).

Stdout is one JSON object:

- `mcpUrl` is the public MCP URL.
- `owner.password` is a generated owner password. It is for a later browser
  login. The first browser login also enrolls a passkey. The MCP token does
  not need that login.
- `admin.token` is a bearer token for every configured area, expiring in 90
  days. With `--project`, it is bound to that project.
- `mcp` is a URL plus an `Authorization` header.
- `cursor` is a Cursor `mcp.json` document.

The password and token are printed only when this command creates them.
Running it again is safe and prints `Bearer <already issued>` instead.
Store them somewhere private. `context token create` issues another client
later. `context token list` does not show the secret.

If the owner was already created with `context owner init`, `context init`
leaves that password alone and only issues the token.

## Connect a client

Put `cursor` in `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json`
(this project). Replace the token with the one `context init` printed:

```json
{
  "mcpServers": {
    "context": {
      "url": "https://context.example/mcp",
      "headers": {
        "Authorization": "Bearer TOKEN"
      }
    }
  }
}
```

Any other HTTP MCP client uses the same URL and header. That is the `mcp`
object from the command:

```json
{
  "url": "https://context.example/mcp",
  "headers": {
    "Authorization": "Bearer TOKEN"
  }
}
```

A browser client can also use the URL alone and sign in with the owner
password and a passkey. That consent screen is area-only; it does not bind
a project.

## First remember and search

Ask the client to save a note, for example: remember that the synthetic
lighthouse key is in the blue cabinet. Then open a new conversation and ask
it to search for the lighthouse key.

The client has to call `remember`, then `search`. A chat reply that never
calls Context is not a save. `read` opens one result by id. `timeline` lists
recent notes. Capture and search work with no LLM. To turn interpretation
on, see [LLM providers](llm-providers.md).

## Store an ADR or a spec

An architect token can write the current ADR or spec for a project. Create
the project first (`context init --project` or `context project create`).
The token needs write access to the project's area. `--project` binds the
token so `remember` does not have to repeat the id.

Ask the client to remember the decision as a document. The call is still
`remember`. `doc.type` is `adr`, `spec` or `note`. `doc.key` is stable
(`0012`, `adr:0012` or a slug). `doc.title` is the heading. ADR status is
`proposed`, `accepted`, `superseded` or `rejected`. Spec status is `draft`,
`active` or `obsolete`. A later remember with the same key stores the next
revision and records the token's name on that status. It does not approve a
distilled fact or decision. That remains `context project review`.

Read the current text with `doc:<project>:<adr|spec|note>:<key>`. Add `@1`
for the first revision. The reply lists every revision. Search returns the
current revision only. `kind: "doc"` limits the results to documents, and
`docType` narrows the type. An accepted ADR or an active spec outranks an
equal older status. A superseded document still reads by id.

A folder of markdown can load the same records. Put `type`, `key` and
`status` in the front matter and import it:

```sh
context import markdown ./docs --area projects --project notes
```

Quote a numeric key (`key: "0012"`) so leading zeros stay. Details are in
[Imports](imports.md) and [ADR 0018](adr/0018-documents-are-versioned-sources.md).

## Curated read-only instance

A website assistant (cases, resume, specialist info) can use its own Context
with the processor left off. Import a folder of markdown, issue a token with
`--read` and no `--write`, and treat `search` `grounding: none` as "I don't
know". The steps are in [Curated instance](curated-instance.md).
