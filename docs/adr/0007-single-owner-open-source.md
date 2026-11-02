# Build an MIT single-owner self-hosted engine

Status: Accepted

Date: 2026-11-02

## Context

The owner needs portable personal memory that survives changing AI clients and
providers without maintaining a collection of services.

## Decision

Context is an MIT open-source personal context engine for one owner, self-hosted
and runnable with one `docker run` command. After setup it is a black box: routine
capture, processing and maintenance work by themselves. Any authorized agent
accesses it through MCP. Include an owner web UI in the core for search, inbox
decisions, deletion and clients/tokens; these operations are also available via MCP.
Keep the existing MIT LICENSE.

## Consequences

Multi-tenancy and an agent orchestration platform are outside the product.
Provider changes must preserve usable memory. One-command operation is a target,
not today's protected pilot installation. Setup still includes owner credentials,
rights and a backup target; uncertain or consequential decisions remain the owner's.
