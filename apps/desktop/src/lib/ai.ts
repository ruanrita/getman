/**
 * In-app AI assistant. Bring-your-own-key: Getman never provides an LLM.
 *
 * Sources:
 * - "device": the user's own key, stored on this device; the app calls the
 *   provider directly (Anthropic via the official SDK, others through their
 *   OpenAI-compatible endpoint).
 * - "workspace": the server workspace's shared AI; the server holds the key
 *   and proxies the call (apps/server/src/routes/ai.ts).
 *
 * Answers are grounded in the bundled docs (docs/), sent as one cached system block.
 */
import Anthropic from "@anthropic-ai/sdk";
import { effectiveAuth, findItemPath, type RequestItem, type Variable, type Workspace } from "@getman/core";
import { apiFor } from "./sync";
import type { RunResult } from "./store";
import { isTauri } from "./transport";
import { DEFAULT_ANTHROPIC_MODEL, PRESETS, type AiSettings } from "./aiConfig";

export * from "./aiConfig";

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`) on the Claude API. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/* ---------- documentation context ---------- */

const docFiles = import.meta.glob("../../../../docs/**/*.{md,txt}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Stable order (index and limitations first) so the cached prefix never changes between requests. */
function bundleDocs(): string {
  const entries = Object.entries(docFiles).map(([path, text]) => [path.replace(/^(\.\.\/)+/, ""), text] as const);
  const rank = (p: string) => (p.endsWith("llms.txt") ? 0 : p.endsWith("limitations.md") ? 1 : 2);
  entries.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return entries.map(([path, text]) => `<doc path="${path}">\n${text.trim()}\n</doc>`).join("\n\n");
}

export const DOCS = bundleDocs();

export const SYSTEM_PROMPT = `You are the help assistant inside Getman, an open source API client (an alternative to Postman). People ask you how to use Getman, what it can and cannot do, and for help debugging their API requests and scripts.

Ground every statement about Getman in the documentation below. Each page's frontmatter has a status: "implemented", "partial" or "planned". A planned feature does not exist yet - say it is planned rather than explaining how to use it. For "can Getman do X?" questions, check limitations.md first. If the documentation does not cover something, say so plainly instead of guessing; general HTTP, REST and JavaScript knowledge is fine to use.

Reply in the language the user writes in. Keep answers short and practical: lead with the answer, show a small example when it helps (for scripts, use the pm.* API exactly as documented), and name the doc page (for example docs/features/scripts.md) when the user may want to read more.

The user may attach their current request, response and test results. Secret values in it are replaced with «secret». Never ask the user to paste secrets, passwords or API keys.

<documentation>
${DOCS}
</documentation>`;

/* ---------- request context (opt-in) ---------- */

const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;
const clip = (s: string, max = 4000) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s);

function varLine(v: Variable) {
  return `${v.key} = ${v.secret ? "«secret»" : v.value ? JSON.stringify(v.value) : "(empty)"}${v.localValue ? " (has a local value, hidden)" : ""}`;
}

/** What the user is looking at, with secrets removed. Only sent when they tick "Include current request". */
export function describeContext(ws: Workspace, collectionId: string | undefined, itemId: string | undefined, result: RunResult | undefined): string | undefined {
  const col = ws.collections.find((c) => c.id === collectionId);
  if (!col || !itemId) return undefined;
  const path = findItemPath(col, itemId);
  if (path?.item.kind !== "request") return undefined;
  const req = path.item as RequestItem;
  const env = ws.environments.find((e) => e.id === ws.activeEnvironmentId);
  const auth = effectiveAuth(req, path.ancestors);

  const lines = [
    `Request "${req.name}" in collection "${col.name}":`,
    `${req.method} ${req.url}`,
    ...req.params.filter((p) => p.key).map((p) => `  query ${p.enabled ? "" : "(disabled) "}${p.key}=${p.value}`),
    ...req.headers.filter((h) => h.key).map((h) => `  header ${h.enabled ? "" : "(disabled) "}${h.key}: ${SENSITIVE_HEADER.test(h.key) ? "«secret»" : h.value}`),
    `Auth: ${auth.type}${req.auth.type === "inherit" ? " (inherited)" : ""}`,
    req.body.mode !== "none" ? `Body (${req.body.mode}):\n${clip(req.body.mode === "json" || req.body.mode === "raw" ? req.body.raw : req.body.form.map((f) => `${f.key}=${f.value}`).join("\n"), 3000)}` : "",
    req.scripts.preRequest.trim() ? `Pre-request script:\n${clip(req.scripts.preRequest, 3000)}` : "",
    req.scripts.test.trim() ? `Test script:\n${clip(req.scripts.test, 3000)}` : "",
    env ? `Active environment "${env.name}":\n${env.variables.map((v) => `  ${varLine(v)}`).join("\n")}` : "No active environment.",
    col.variables.length ? `Collection variables:\n${col.variables.map((v) => `  ${varLine(v)}`).join("\n")}` : "",
  ];
  if (result?.error) lines.push(`Last send failed: ${result.error}`);
  if (result?.response) {
    const r = result.response;
    lines.push(
      `Last response: ${r.status} ${r.statusText}, ${r.timeMs} ms`,
      ...r.headers.map(([k, v]) => `  ${k}: ${SENSITIVE_HEADER.test(k) ? "«secret»" : v}`),
      `Response body:\n${clip(r.body)}`,
    );
  }
  if (result?.tests.length) lines.push(`Tests:\n${result.tests.map((t) => `  ${t.passed ? "PASS" : "FAIL"} ${t.name}${t.error ? ` - ${t.error}` : ""}`).join("\n")}`);
  const errors = result?.logs.filter((l) => l.level === "error") ?? [];
  if (errors.length) lines.push(`Script errors:\n${errors.map((l) => `  [${l.source}] ${l.message}`).join("\n")}`);

  // Secrets that only exist as local values must never leave the device, even inside a request.
  let text = lines.filter(Boolean).join("\n");
  for (const v of [...(env?.variables ?? []), ...col.variables, ...ws.globals]) {
    for (const value of [v.secret ? v.value : "", v.localValue ?? ""]) {
      if (value && value.length >= 4) text = text.split(value).join("«secret»");
    }
  }
  return text;
}

/* ---------- chat ---------- */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Anthropic response blocks, replayed unchanged on the next turn (keeps the history append-only). */
  raw?: Anthropic.Beta.BetaContentBlock[];
  /** Which backend answered, for display. */
  via?: string;
}

async function anthropicChat(s: AiSettings, history: ChatMessage[], onText: (t: string) => void, signal: AbortSignal): Promise<ChatMessage> {
  const tauriFetch = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : undefined;
  const client = new Anthropic({
    apiKey: s.apiKey,
    baseURL: s.baseUrl || undefined,
    // The key belongs to the user and stays on their device; there is no server to hide it behind.
    dangerouslyAllowBrowser: true,
    fetch: tauriFetch as typeof fetch | undefined,
    maxRetries: 2,
  });
  const model = s.model || DEFAULT_ANTHROPIC_MODEL;
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 64000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: history.map((m) => ({ role: m.role, content: m.raw ? (m.raw as Anthropic.Beta.BetaContentBlockParam[]) : m.content })),
      ...(FALLBACK_MODELS.has(model) && !s.baseUrl ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    },
    { signal },
  );
  stream.on("text", onText);
  try {
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      return { role: "assistant", content: "The model declined to answer this. Try rephrasing the question.", raw: final.content, via: final.model };
    }
    const text = final.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { role: "assistant", content: text, raw: final.content, via: final.model };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic rejected the API key. Check it in the assistant settings.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error(`Anthropic denied access: ${e.message}`);
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Model "${model}" was not found. Check the model name in settings.`);
    if (e instanceof Anthropic.RateLimitError) throw new Error("Anthropic is rate limiting your key. Wait a moment and try again.");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Could not reach Anthropic. Check your internet connection.");
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic error ${e.status ?? ""}: ${e.message}`);
    throw e;
  }
}

/** Streams from any OpenAI-compatible /chat/completions endpoint (OpenAI, Gemini, OpenRouter, Ollama, LM Studio…). */
async function openAiCompatibleChat(s: AiSettings, history: ChatMessage[], onText: (t: string) => void, signal: AbortSignal): Promise<ChatMessage> {
  if (!s.baseUrl || !s.model) throw new Error("Set the base URL and model in the assistant settings.");
  const doFetch = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  let res: Response;
  try {
    res = await doFetch(`${s.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({
        model: s.model,
        stream: true,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.map((m) => ({ role: m.role, content: m.content }))],
      }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`Could not reach ${s.baseUrl}. ${isTauri() ? "" : "In the browser dev build the provider must allow CORS; the desktop app does not need it. "}(${(e as Error).message})`);
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Provider error ${res.status}: ${data?.error?.message ?? res.statusText}`);
  }

  // Server-sent events: "data: {json}\n\n", ending with "data: [DONE]".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = s.model;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "").trim();
      if (!line.startsWith("data:") || !data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data);
        model = chunk.model ?? model;
        const delta: string | undefined = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(delta);
        }
      } catch {
        // Ignore keep-alive or partial lines.
      }
    }
  }
  return { role: "assistant", content: text, via: model };
}

export async function sendChat(opts: {
  settings: AiSettings;
  workspace: Workspace;
  history: ChatMessage[];
  onText: (delta: string) => void;
  signal: AbortSignal;
}): Promise<ChatMessage> {
  const { settings: s, workspace: ws, history } = opts;
  if (s.source === "workspace") {
    if (ws.storage.kind !== "server") throw new Error("Workspace AI is only available in workspaces shared on a server.");
    const res = await apiFor(ws.storage.url).workspaceAiChat(ws.id, { system: SYSTEM_PROMPT, messages: history.map((m) => ({ role: m.role, content: m.content })) });
    opts.onText(res.text);
    return { role: "assistant", content: res.text, via: `${res.model} · workspace` };
  }
  const preset = PRESETS.find((p) => p.id === s.preset);
  if (preset?.needsKey && !s.apiKey) throw new Error(`Add your ${preset.label} API key in the assistant settings.`);
  return s.provider === "anthropic" ? anthropicChat(s, history, opts.onText, opts.signal) : openAiCompatibleChat(s, history, opts.onText, opts.signal);
}
