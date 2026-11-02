# Use a pluggable processor

Status: Accepted

Date: 2026-11-02

## Context

Understanding requires inference, but changing AI providers must not strand
memory or interrupt capture and retrieval.

## Decision

Use an explicitly configured OpenAI-compatible chat-completions endpoint through
`fetch`: OpenAI, OpenRouter, or a compatible local Ollama/llama.cpp endpoint.
`CONTEXT_LLM_API_KEY` and `CONTEXT_LLM_MODEL` enable model steps;
`CONTEXT_LLM_BASE_URL` defaults to `https://api.openai.com/v1`. No SDK is needed.
Provider choice does not change the archive, access policy or MCP contract.

Remove the subscription CLI path: the adapter required exactly Codex CLI 0.164.0,
the owner reports server 0.166.0, and the image contains no Codex runtime. It had
only an operator-run `memory:process` caller; that command now uses this same
client. Existing queued jobs and validated durable outputs remain retryable.

## Consequences

Capture, retrieval and deterministic dedup need no API key. Model steps report
`not_configured` without both key and model; there is no paid fallback. A local
endpoint can use a placeholder key. Requests send redacted text only, have a
30-second timeout and bounded responses, reject redirects, and validate output.
Provider failures skip an item and never overwrite sources. Live provider quality
and availability require separate evidence; a compatible protocol alone is not
quality acceptance. This decision supersedes the subscription/API choice in the
original 2 November 2026 decision.
