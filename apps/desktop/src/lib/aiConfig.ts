/** AI assistant settings and provider presets. No imports, so the store can use it without cycles. */
export type AiProvider = "anthropic" | "openai-compatible";

export interface AiSettings {
  source: "device" | "workspace";
  preset: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Preset {
  id: string;
  label: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  keyHelp?: string;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic (Claude)", provider: "anthropic", baseUrl: "", model: DEFAULT_ANTHROPIC_MODEL, needsKey: true, keyHelp: "console.anthropic.com → API keys" },
  { id: "openai", label: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "", needsKey: true, keyHelp: "platform.openai.com → API keys" },
  { id: "gemini", label: "Google Gemini", provider: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "", needsKey: true, keyHelp: "aistudio.google.com → API keys" },
  { id: "openrouter", label: "OpenRouter", provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "", needsKey: true },
  { id: "ollama", label: "Ollama (local, free)", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "", needsKey: false },
  { id: "custom", label: "Other OpenAI-compatible", provider: "openai-compatible", baseUrl: "", model: "", needsKey: false },
];

export const DEFAULT_AI_SETTINGS: AiSettings = { source: "device", preset: "anthropic", provider: "anthropic", baseUrl: "", model: DEFAULT_ANTHROPIC_MODEL, apiKey: "" };
