# Areas control access; the inbox handles uncertainty

Status: Accepted  
Date: 2026-11-02

## Context

Capture should require no manual categorization, while client access remains
explicit and independent of inferred meaning.

## Decision

The owner defines areas, for example personal, finance or infra. Each client has
a default write area and allowed read/write areas. Imports map their source
bot or repository to an area. A client may specify an area only within its write
rights; unknown destinations go to inbox. The server sorts inbox daily and sends
uncertain items to an owner one-click decision. Area is access control, not topic.

## Consequences

Inbox fallback cannot bypass write authorization; clients need permission to
capture there. Explicit unauthorized area requests are denied. Automatic moves
must follow owner-authorized routing and disclosure policy; model confidence
alone cannot grant access. Topic/project inference never changes client rights.
The owner resolves routing uncertainty through MCP, and later the owner web UI.
