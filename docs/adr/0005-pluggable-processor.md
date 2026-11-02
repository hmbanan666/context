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

The OpenAI-compatible API remains the documented open-source default.
Owner-approved `CONTEXT_PROCESSOR=codex` opts tidy and `memory:process` into the
CLI's own ChatGPT subscription login, with an isolated ephemeral read-only run
and no version pin. Context never reads auth files, and unavailable CLI calls
leave tidy doing embedding-only dedup without changing sources.

## Consequences

Capture, retrieval and deterministic dedup need no API key. Model steps report
`not_configured` without both key and model in API mode; there is no paid fallback.
A local endpoint can use a placeholder key. Requests send redacted text only, have a
30-second API timeout (180 seconds for Codex) and bounded responses, reject API
redirects, and validate output.
Provider failures skip an item and never overwrite sources. Live provider quality
and availability require separate evidence; a compatible protocol alone is not
quality acceptance.
