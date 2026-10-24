import Anthropic from "@anthropic-ai/sdk";
import { badRequest, HttpError } from "../errors";

export type AiProvider = "anthropic" | "openai-compatible";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
}

export interface ChatResult {
  text: string;
  stopReason: string | null;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`) on the Claude API. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Non-streaming completion used by the workspace AI proxy (the server holds
 * the key; members never see it).
 */
export async function complete(provider: AiProvider, opts: { apiKey?: string; baseUrl?: string; model?: string }, req: ChatRequest): Promise<ChatResult> {
  if (provider === "anthropic") {
    if (!opts.apiKey) throw badRequest("The workspace AI has no API key", "ai_not_configured");
    const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined, maxRetries: 2 });
    const model = opts.model || DEFAULT_ANTHROPIC_MODEL;
    try {
      const msg = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Help-chat answers: low effort keeps latency and cost down.
        output_config: { effort: "low" },
        // The docs block is identical across requests, so it is cached.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
        ...(FALLBACK_MODELS.has(model) && !opts.baseUrl ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      if (msg.stop_reason === "refusal") {
        return { text: "The model declined to answer this question.", stopReason: "refusal", model: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
      }
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, stopReason: msg.stop_reason, model: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, "ai_auth_failed", "The workspace AI key was rejected by Anthropic. Ask an admin to update it.");
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "ai_rate_limited", "The AI provider is rate limiting this workspace. Try again shortly.");
      if (e instanceof Anthropic.APIError) throw new HttpError(502, "ai_provider_error", `AI provider error (${e.status ?? "network"}): ${e.message}`);
      throw e;
    }
  }

  if (!opts.baseUrl || !opts.model) throw badRequest("The workspace AI needs a base URL and a model", "ai_not_configured");
  const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
    body: JSON.stringify({ model: opts.model, messages: [{ role: "system", content: req.system }, ...req.messages] }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new HttpError(502, "ai_provider_error", `AI provider error (${res.status}): ${data?.error?.message ?? res.statusText}`);
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    stopReason: data.choices?.[0]?.finish_reason ?? null,
    model: data.model ?? opts.model,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}
