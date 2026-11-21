# LLM providers

Context stores sources and answers `search`, `remember`, `read`, and
`timeline` with no model. A processor is only for nightly tidy: distillation
into proposed facts and decisions, and inbox sorting. Deduplication still
runs when no processor is configured.

The default install leaves the processor off.

## None

Leave `CONTEXT_LLM_API_KEY` and `CONTEXT_LLM_MODEL` unset, including in
`.env`. `CONTEXT_PROCESSOR` can stay unset. Tidy reports the model as not
configured and does not call one. Nothing is sent off the machine for
interpretation.

## OpenAI-compatible, including OpenRouter

Set both a model name and a key. The client speaks the chat-completions API.
`CONTEXT_PROCESSOR` may be `openai` or unset; both select this client.

```dotenv
CONTEXT_PROCESSOR=openai
CONTEXT_LLM_BASE_URL=https://api.openai.com/v1
CONTEXT_LLM_API_KEY=your-key
CONTEXT_LLM_MODEL=your-model
```

OpenRouter is the same client with a different base URL and model id:

```dotenv
CONTEXT_PROCESSOR=openai
CONTEXT_LLM_BASE_URL=https://openrouter.ai/api/v1
CONTEXT_LLM_API_KEY=your-key
CONTEXT_LLM_MODEL=your-model
```

A local server that ignores the key still needs some non-empty key, because
an empty key means "off". Use a placeholder. `http://` is accepted for a
local base URL. The base URL must not include a username, password, query,
or fragment. Context calls `{base}/chat/completions`.

Tidy sends redacted source text to that endpoint. The key and the model
response are not written into tidy history. If either the key or the model
is missing, the processor stays off.

`compose.yaml` forwards these four variables and `CONTEXT_DISTILL_LANGUAGE`.
Uncomment them in `.env` and restart the container. No extra service or
volume is required.

## Codex

`CONTEXT_PROCESSOR=codex` uses a Codex CLI binary and that CLI's ChatGPT
device login. It is for a personal install. It is a poor fit for a new
shared instance: the CLI version is not pinned, the login is a device code
that expires, and a missing binary or login leaves tidy on deduplication
with `llm: "unavailable"`.

Do not put a ChatGPT session directory from an agent into the container.
The login directory is a new one, and the login is `codex login --device-auth`
on the host. The plain `compose.yaml` does not mount the binary or that
directory. Use the overlay in
[deployment](deployment.md#optional-codex-subscription-processor).
No API key is used. The model defaults to `gpt-6-luna` when
`CONTEXT_LLM_MODEL` is unset.

## Output language

Distillation writes each sentence in the language of that source. An English
source stays English. A Russian source stays Russian. The model wrappers say
the same thing, because a ChatGPT account language is not local user config
and `--ignore-user-config` does not clear it. The weekly journal is not a
model call. It copies cited sentences, so it uses the language of the majority
of those items, counted by item. A tie goes to Russian.

Set `CONTEXT_DISTILL_LANGUAGE` to `ru`, `en`, `de`, `fr`, or `es` to force
both distillation and journals. Leave it unset to follow the source. Any other
value is ignored. Compose forwards the variable.

A reply in another language is tried once more. The check is the script
(Cyrillic or Latin) plus a small stopword list for German, French, and Spanish
against English. If the retry is still wrong, the source stays pending and is
not stored. Stderr gets one line with the expected and detected language and
no source text. A journal that is still in the wrong language is rebuilt once
from the items already in the expected language, and otherwise left unwritten.
