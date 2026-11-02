# Back up nightly with an off-host copy

Status: Accepted

Date: 2026-11-02

## Context

Manual SQLite snapshots and a same-host backup volume do not provide unattended
recovery after loss of the host.

## Decision

Run nightly backups with an off-host copy to an owner-configurable SFTP or
S3-compatible backup target. Include the durable state needed to recover the
single-owner engine and its access policy. Validate recovery from the remote copy. Store plain SQLite snapshots, with TLS
for S3 or SSH for SFTP in transit. Client-side backup encryption is explicitly
out of scope by the owner's 2 November 2026 simplicity decision.

## Consequences

Snapshot success and off-host delivery are separate observable results with safe
retries; a failed upload is not a successful off-host backup. Target credentials
and backup contents stay private. Restore must validate integrity, preserve rights
and account for owner deletion. Nightly snapshots and manual backup tools share verification and retention. Target
setup and remote retention are operator configuration; remote recovery still needs
actual evidence.
