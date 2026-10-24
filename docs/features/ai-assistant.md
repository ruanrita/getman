---
title: AI assistant
summary: In-app chat that answers questions about Getman from these docs, using the user's own LLM key or a key shared by the workspace. Supported providers, privacy, costs and limits.
status: implemented
tags: [ai, assistant, chat, llm, byok, anthropic, claude, openai, gemini, ollama, openrouter]
---

# AI assistant

Click **✦ Ask AI** in the top bar. The assistant answers "how do I…?" and "can Getman…?" questions using this documentation, and can help debug the request you are looking at.

**Getman does not provide an LLM.** You connect your own provider and pay it directly, or use a key your workspace admins configured.

## Providers

| Provider | Setup in ⚙ (assistant settings) |
|---|---|
| **Anthropic (Claude)** | API key from console.anthropic.com. Default model `claude-opus-5-5`. |
| OpenAI | API key + model name |
| Google Gemini | API key from aistudio.google.com + model name |
| OpenRouter | API key + model name |
| **Ollama** (local, free) | Run Ollama, enter the model name (e.g. one you pulled with `ollama pull`). No key. |
| Other OpenAI-compatible (LM Studio, vLLM, Azure OpenAI, …) | Base URL + model, key if required |

Anthropic uses the official SDK. Every other provider is called through its OpenAI-compatible `/chat/completions` endpoint. Answers stream in as they are written (the workspace AI answers all at once).

## Where the key lives

| Option | Who sets it | Stored | Who pays |
|---|---|---|---|
| **My own key** | each user, in the assistant ⚙ | on this device only; sent only to the provider | that user |
| **Workspace AI** | owner/admin, in ⚙ workspace settings → **AI assistant** | on the server, encrypted (AES-256-GCM); never sent to members | the workspace's key owner |

When a server workspace has Workspace AI turned on, members choose between it and their own key in the assistant settings. Admins see per-member usage for the last 30 days in the same tab.

## What is sent

- **Always:** your question, the earlier messages of the conversation, and the full Getman documentation (as a cached prompt, so repeat questions are cheap on Anthropic).
- **Only if you tick "Include current request":** the selected request (method, URL, params, headers, body, scripts), the active environment's variable names and shared values, the last response (body truncated to 4 KB) and test results. Secret values, local values and `Authorization`/`Cookie`/API-key headers are replaced with `«secret»` before sending.
- Nothing is sent until you press Send.

## Answers you can expect

- Grounded in the documentation; features marked `planned` are described as planned, not available.
- In the language you write in.
- If something isn't documented, the assistant says so instead of guessing.

## Costs and models

- With Anthropic, Getman asks for **low effort** answers (fast and cheap for help questions) and turns on Anthropic's automatic **refusal fallback** for models that support it.
- The documentation is about 13k tokens per request; Anthropic's prompt cache makes repeat questions within a few minutes much cheaper.

## Limitations

- Conversations are not saved; **New** or closing the app clears them.
- The personal key is stored in the app's storage, not yet in the OS keychain.
- In the browser dev build (`pnpm dev`), providers other than Anthropic must allow CORS; the desktop app does not need it.
- The assistant cannot change your requests or run them; it only answers.
- Workspace AI does not stream.

## Implementation

- Desktop: `apps/desktop/src/lib/ai.ts` (providers, docs bundle, context builder, system prompt), `src/components/AiPanel.tsx`.
- Server: `apps/server/src/routes/ai.ts`, `src/ai/providers.ts`.
