import { useEffect, useState } from "react";
import { DEFAULT_ANTHROPIC_MODEL, PRESETS } from "../lib/aiConfig";
import { ApiError, type ServerApi } from "../lib/api";
import { toast, ask } from "../lib/ui";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** Admin setting: one AI key for the whole workspace, kept on the server. */
export function WorkspaceAiTab({ wsId, api }: { wsId: string; api: ServerApi }) {
  const [state, setState] = useState<Awaited<ReturnType<ServerApi["workspaceAi"]>>>();
  const [preset, setPreset] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(DEFAULT_ANTHROPIC_MODEL);
  const [apiKey, setApiKey] = useState("");
  const [usage, setUsage] = useState<Awaited<ReturnType<ServerApi["workspaceAiUsage"]>>["usage"]>([]);

  const load = async () => {
    const s = await api.workspaceAi(wsId);
    setState(s);
    if (s.enabled) {
      const match = PRESETS.find((p) => p.provider === s.provider && (p.provider === "anthropic" || p.baseUrl === s.baseUrl));
      setPreset(match?.id ?? "custom");
      setBaseUrl(s.baseUrl ?? "");
      setModel(s.model ?? "");
    }
    setUsage((await api.workspaceAiUsage(wsId)).usage);
  };
  useEffect(() => void load().catch((e) => toast(errorText(e))), [wsId]);

  const p = PRESETS.find((x) => x.id === preset)!;
  const save = (body: Parameters<ServerApi["configureWorkspaceAi"]>[1], ok: string) =>
    api.configureWorkspaceAi(wsId, body).then(
      () => (toast(ok), setApiKey(""), void load()),
      (e) => toast(errorText(e)),
    );

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
      <p className="hint" style={{ margin: 0 }}>
        Give every member the assistant without each one needing a key. The key is stored encrypted on the server and never sent to members; this
        workspace pays for all usage. Members can still use their own key instead.
      </p>
      <div>
        Status: {state?.enabled ? <strong style={{ color: "var(--success)" }}>on · {state.model}</strong> : <span className="muted">off</span>}
        {state?.enabled && !state.hasKey && <span className="muted"> (no key stored)</span>}
      </div>
      <label>
        Provider
        <select
          className="select"
          style={{ width: "100%" }}
          value={preset}
          onChange={(e) => {
            const next = PRESETS.find((x) => x.id === e.target.value)!;
            setPreset(next.id);
            setBaseUrl(next.baseUrl);
            setModel(next.model);
          }}
        >
          {PRESETS.filter((x) => x.id !== "ollama").map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      {p.provider === "openai-compatible" && (
        <label>
          Base URL
          <input className="input mono" style={{ width: "100%" }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      )}
      <label>
        Model
        <input className="input mono" style={{ width: "100%" }} value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        API key {state?.hasKey && <span className="muted">(leave empty to keep the stored key)</span>}
        <input className="input mono" style={{ width: "100%" }} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </label>
      <div className="row">
        <button
          className="btn primary"
          disabled={!state?.hasKey && !apiKey && p.needsKey}
          onClick={() =>
            save({ provider: p.provider, baseUrl: p.provider === "anthropic" ? null : baseUrl, model: model || null, ...(apiKey ? { apiKey } : {}) }, "Workspace AI saved")
          }
        >
          Save
        </button>
        {state?.enabled && (
          <button className="btn danger" onClick={async () => (await ask("Turn off workspace AI and delete the stored key?")) && save({ provider: null, apiKey: null }, "Workspace AI turned off")}>
            Turn off
          </button>
        )}
      </div>

      {usage.length > 0 && (
        <div className="section">
          <h4>Usage, last 30 days</h4>
          <table className="kv">
            <tbody>
              {usage.map((u) => (
                <tr key={u.email}>
                  <td style={{ padding: 6 }}>{u.email}</td>
                  <td style={{ padding: 6 }}>{u.requests} questions</td>
                  <td className="muted" style={{ padding: 6 }}>
                    {u.inputTokens.toLocaleString()} in · {u.outputTokens.toLocaleString()} out tokens
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
