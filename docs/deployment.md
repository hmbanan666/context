# Dokploy deployment hypothesis

**Status:** Planned. No deployment has been performed or verified.

Host Context as an independent Dokploy application. The owner's admin panel
is **not** the service URL, and Dokploy itself is not an OAuth provider.

## Preflight

- Implement and test Sprint 0 and Sprint 1 locally.
- Configure a separately approved, stable HTTPS hostname for Context MCP.
- Implement and verify OAuth 2.1 using a compatible identity provider;
  ChatGPT must successfully authenticate and invoke a scoped tool.
- Limit write scopes, size, request frequency and tool response exposure.
- Configure secrets through Dokploy; keep them out of Git and logs.
- Provide health probe, persistent volume, backup/restore and restart smoke
  tests. SQLite initially assumes a single writer/replica.
- Prevent the MCP service from reading other projects' data or Docker socket.
- Test with synthetic records only until storage and authorization are proven.

## Deployment acceptance

- The deployed service answers HTTPS health checks and MCP initialization.
- Anonymous/private-data reads and writes fail; incorrect scopes fail.
- The ChatGPT plugin can call a real authenticated `capture` and Codex can
  independently `recall` the same record with restricted access.
- Context remains intact after process restart/redeployment.
- Version deployed is explicitly linked to a commit; merge alone is not proof
  of production deployment.

## Authentication notes

The ChatGPT plugin supports no-auth and OAuth connection types, but a
no-auth public endpoint must **not** be exposed to real personal records.
Dokploy domain TLS and ordinary application password gates are not
necessarily compatible with ChatGPT's MCP OAuth linking flow.

If OAuth setup fails, stop before any personal-data deployment and record
the exact linking or discovery failure. Consider a compatible external
identity provider rather than implementing an ad hoc OAuth server.

Secrets, panel addresses, database backups and memory contents remain
private; only synthetic fixtures and public documentation belong in Git.
