# Use a pluggable processor

Status: Accepted  
Date: 2026-11-02

## Context

Understanding requires inference, but changing AI providers must not strand
memory or interrupt capture and retrieval.

## Decision

Make the processor interchangeable. Default processing uses the owner's
subscription/API: Codex CLI on a ChatGPT plan, or an OpenAI/Anthropic API key.
Offer a local LLM as a fallback option. Provider choice does not change the
source archive, access policy or MCP client contract.

## Consequences

Subscription execution, credentials, refresh and quotas must be verified for
the supported runtime; unavailable execution is reported honestly. API use is
explicitly configured, never a silent paid fallback or subscription workaround.
Processing failure leaves sources available and jobs retryable. A local fallback
is an option, not a claim that it matches remote-model quality.
