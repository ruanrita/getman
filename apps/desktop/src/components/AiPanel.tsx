import { useEffect, useRef, useState } from "react";
import { describeContext, PRESETS, sendChat, type AiSettings, type ChatMessage } from "../lib/ai";
import { useActiveWorkspace, useStore } from "../lib/store";
import { apiFor } from "../lib/sync";
import { Markdown } from "./Markdown";

const SUGGESTIONS = [
  "How do I use a token from one request in the next?",
  "Can I import my Postman collection with its scripts?",
  "How do secret variables work?",
  "What does Getman not support yet?",
];

export function AiPanel() {
  const ws = useActiveWorkspace();
  const settings = useStore((s) => s.ai);
  const selection = useStore((s) => s.selection);
  const results = useStore((s) => s.results);
  const { setAi, toggleAi } = useStore.getState();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string>();
  const [error, setError] = useState<string>();
  const [includeContext, setIncludeContext] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [workspaceAi, setWorkspaceAi] = useState<{ enabled: boolean; model?: string }>();
  const abort = useRef<AbortController>(undefined);
  const end = useRef<HTMLDivElement>(null);

  // Is a shared workspace AI available here?
  useEffect(() => {
    setWorkspaceAi(undefined);
    if (ws.storage.kind !== "server") return;
    apiFor(ws.storage.url).workspaceAi(ws.id).then(setWorkspaceAi, () => setWorkspaceAi(undefined));
  }, [ws.id]);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which useEffect must not receive.
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  const usingWorkspace = settings.source === "workspace" && Boolean(workspaceAi?.enabled);
  const configured = usingWorkspace || (settings.provider === "anthropic" ? Boolean(settings.apiKey) : Boolean(settings.baseUrl && settings.model));
  const requestId = selection?.itemId;
  const canAttach = Boolean(requestId && describeContext(ws, selection?.collectionId, requestId, undefined));

  const send = async (question: string) => {
    if (!question.trim() || streaming !== undefined) return;
    const context = includeContext && requestId ? describeContext(ws, selection?.collectionId, requestId, results[requestId]) : undefined;
    const user: ChatMessage = { role: "user", content: context ? `${question}\n\n<my-current-request>\n${context}\n</my-current-request>` : question };
    const history = [...messages, user];
    setMessages(history);
    setDraft("");
    setError(undefined);
    setStreaming("");
    abort.current = new AbortController();
    try {
      const reply = await sendChat({
        settings: usingWorkspace ? settings : { ...settings, source: "device" },
        workspace: ws,
        history,
        signal: abort.current.signal,
        onText: (t) => setStreaming((s) => (s ?? "") + t),
      });
      setMessages([...history, reply]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      // Drop the unanswered question so the history stays valid (user/assistant alternating).
      setMessages(messages);
      setDraft(question);
    } finally {
      setStreaming(undefined);
    }
  };

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <div className="ai-head">
        <strong>✦ Assistant</strong>
        <span className="muted ai-model" title="Model answering">
          {usingWorkspace ? `workspace · ${workspaceAi?.model ?? ""}` : settings.model || PRESETS.find((p) => p.id === settings.preset)?.label}
        </span>
        <span className="spacer" />
        {messages.length > 0 && (
          <button className="btn ghost" onClick={() => (abort.current?.abort(), setMessages([]), setError(undefined))} title="Start a new conversation">
            New
          </button>
        )}
        <button className={`btn ghost icon ${showSettings ? "primary" : ""}`} aria-label="Assistant settings" title="Settings" onClick={() => setShowSettings(!showSettings)}>
          ⚙
        </button>
        <button className="btn ghost icon" aria-label="Close assistant" onClick={() => toggleAi(false)}>
          ×
        </button>
      </div>

      {(showSettings || !configured) && <Settings settings={settings} setAi={setAi} workspaceAi={workspaceAi} />}

      <div className="ai-messages">
        {messages.length === 0 && configured && (
          <div className="ai-empty">
            <p className="muted">Ask anything about Getman. Answers come from the documentation, using {usingWorkspace ? "your workspace's AI" : "your own API key"}.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn ai-suggestion" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            {m.role === "user" ? <div className="ai-bubble">{m.content.replace(/\n\n<my-current-request>[\s\S]*$/, "")}{m.content.includes("<my-current-request>") && <div className="muted ai-attached">📎 current request attached</div>}</div> : <Markdown text={m.content} />}
          </div>
        ))}
        {streaming !== undefined && (
          <div className="ai-msg assistant">{streaming ? <Markdown text={streaming} /> : <span className="muted">Thinking…</span>}</div>
        )}
        {error && <div className="hint warn">{error}</div>}
        <div ref={end} />
      </div>

      <form
        className="ai-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          className="input"
          rows={3}
          placeholder={configured ? "Ask about Getman… (Enter to send, Shift+Enter for a new line)" : "Configure a provider above to start"}
          disabled={!configured}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <div className="row">
          <label className="row muted" style={{ gap: 4, fontSize: 12 }} title="Sends the selected request, last response and test results. Secrets are masked.">
            <input type="checkbox" checked={includeContext} disabled={!canAttach} onChange={(e) => setIncludeContext(e.target.checked)} />
            Include current request
          </label>
          <span className="spacer" />
          {streaming !== undefined ? (
            <button type="button" className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!configured || !draft.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function Settings({ settings, setAi, workspaceAi }: { settings: AiSettings; setAi(p: Partial<AiSettings>): void; workspaceAi?: { enabled: boolean; model?: string } }) {
  const preset = PRESETS.find((p) => p.id === settings.preset) ?? PRESETS[0]!;
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="ai-settings">
      {workspaceAi?.enabled && (
        <div className="row" style={{ gap: 12 }}>
          <label className="row" style={{ gap: 4 }}>
            <input type="radio" checked={settings.source === "workspace"} onChange={() => setAi({ source: "workspace" })} /> Workspace AI
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="radio" checked={settings.source === "device"} onChange={() => setAi({ source: "device" })} /> My own key
          </label>
        </div>
      )}
      {settings.source === "workspace" && workspaceAi?.enabled ? (
        <p className="muted" style={{ margin: 0 }}>Provided by this workspace's admins ({workspaceAi.model}). Usage is billed to their key.</p>
      ) : (
        <>
          <label>
            Provider
            <select
              className="select"
              style={{ width: "100%" }}
              value={settings.preset}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.id === e.target.value)!;
                setAi({ preset: p.id, provider: p.provider, baseUrl: p.baseUrl, model: p.model });
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {(preset.provider === "openai-compatible" || settings.preset === "custom") && (
            <label>
              Base URL
              <input className="input mono" style={{ width: "100%" }} value={settings.baseUrl} placeholder="https://…/v1" onChange={(e) => setAi({ baseUrl: e.target.value })} />
            </label>
          )}
          <label>
            Model
            <input
              className="input mono"
              style={{ width: "100%" }}
              value={settings.model}
              placeholder={preset.provider === "anthropic" ? "claude-opus-5-5" : "model name from your provider"}
              onChange={(e) => setAi({ model: e.target.value })}
            />
          </label>
          <label>
            API key {!preset.needsKey && <span className="muted">(optional)</span>}
            <div className="row">
              <input
                className="input mono"
                style={{ flex: 1 }}
                type={revealed ? "text" : "password"}
                value={settings.apiKey}
                autoComplete="off"
                onChange={(e) => setAi({ apiKey: e.target.value })}
              />
              <button type="button" className="btn ghost icon" aria-label="Show key" onClick={() => setRevealed(!revealed)}>
                👁
              </button>
            </div>
            {preset.keyHelp && <span className="muted" style={{ fontSize: 12 }}>Get one at {preset.keyHelp}</span>}
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Your key stays on this device and is sent only to the provider. You pay the provider for usage.
          </p>
        </>
      )}
    </div>
  );
}
