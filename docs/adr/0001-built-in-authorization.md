# Built-in authorization replaces Keycloak

Status: Accepted  
Date: 2026-11-02

## Context

One owner needs standard MCP clients and headless agents to connect without
operating a separate identity service and database.

## Decision

Put an OAuth 2.1 authorization server in the core with Dynamic Client
Registration (DCR) and authorization-code PKCE. Owner login uses password +
passkey (WebAuthn), with no separate MFA. Support standard MCP OAuth clients
including ChatGPT, Claude and Cursor, and CLI-issued bearer tokens via
`context token create <client> --scope ...` for headless agents. List every
client with its rights and allow revocation. Replace Keycloak and its PostgreSQL
database in stage 1b.

## Consequences

Context owns the authentication and credential lifecycle. Registration does not
grant data access without owner authorization. Existing ChatGPT/Codex connections
must reconnect; migration must preserve sources and explicitly assigned rights.
Current deployment stays on Keycloak until stage 1b ships. Actual client refresh
after inactivity and revocation require end-to-end evidence.
