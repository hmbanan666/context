# Back up nightly with an off-host copy

Status: Accepted

Date: 2026-11-02

## Context

Manual SQLite snapshots and a same-host backup volume do not provide unattended
recovery after loss of the host.

## Decision

Run nightly backups with an off-host copy to an owner-configurable SFTP or
S3-compatible backup target. Include the durable state needed to recover the
single-owner engine and its access policy. Validate recovery from the remote copy.

## Consequences

Snapshot success and off-host delivery are separate observable results with safe
retries; a failed upload is not a successful off-host backup. Target credentials
and backup contents stay private. Restore must validate integrity, preserve rights
and account for owner deletion. Existing manual backup tools remain the current
mechanism until stage 1c ships; target setup and retention are operator configuration.
