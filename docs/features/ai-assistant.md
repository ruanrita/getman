---
title: AI assistant
summary: Planned in-app chat that answers questions about Getman using these docs, with the user's own LLM key (per account or per workspace).
status: planned
tags: [ai, assistant, chat, llm, byok, anthropic, openai, ollama]
---

# AI assistant

> **Status: planned (phase 2).** Not available yet.

A chat panel that answers "how do I…?" and "can Getman…?" questions using this documentation. **Getman does not provide an LLM.** Users connect their own provider and pay for their own usage.

## Providers

| Provider | Auth |
|---|---|
| Anthropic (Claude) | API key |
| OpenAI | API key |
| Google Gemini | API key |
| OpenAI-compatible endpoint (Azure OpenAI, OpenRouter, LM Studio, vLLM…) | base URL + key |
| Ollama (local, free) | base URL, no key |

## Where the key lives

Configurable at two levels. **Account wins over workspace.**

| Level | Who sets it | Stored | Who pays |
|---|---|---|---|
| Account | the user | OS keychain on the device (never on the server) | that user |
| Workspace | admin/owner (`ai.configure`) | server, encrypted at rest (AES-256-GCM, key from server env) | the workspace owner's org |

Workspace keys are never sent to clients: the server proxies chat calls and logs usage per member.

## How answers are grounded

1. The docs folder is bundled with the app (and served by the server).
2. The docs are small enough to send whole as context, starting with `llms.txt` and `limitations.md`. No vector database needed. Prompt caching keeps repeat questions cheap on providers that support it.
3. System prompt rules:
   - answer only from the docs; if it isn't documented, say so;
   - never present `status: planned` features as available;
   - answer in the user's language;
   - link to the relevant doc page.
4. Optional context the user can attach: the current request (secrets masked), the last response, a failing test.

## Privacy

- Nothing is sent to an LLM unless the user opens the chat and sends a message.
- Secret and local variable values are replaced with `«secret»` before any request/response is attached.
- Chat history is stored locally (per device) unless the workspace enables shared history.

## Docs rules this depends on

See `CLAUDE.md` at the repo root: every feature change updates its doc page, frontmatter `status`, and `limitations.md`.
