import { useEffect, useMemo, useState } from "react";
import { HTTP_METHODS, splitUrl, type BodyMode, type HttpMethod, type RequestItem } from "@getman/core";
import { exportCurl } from "@getman/importers";
import { previewRequest, runRequest } from "../lib/runRequest";
import { draftKey } from "../lib/drafts";
import { useStore } from "../lib/store";
import { HistoryModal } from "./HistoryModal";
import { SaveControls } from "./SaveControls";
import { toast } from "../lib/ui";
import { AuthEditor } from "./AuthEditor";
import { KeyValueTable } from "./KeyValueTable";
import { ResponseViewer } from "./ResponseViewer";
import { ScriptEditor } from "./ScriptEditor";

type Tab = "params" | "headers" | "body" | "auth" | "pre" | "tests" | "code";

interface Props {
  collectionId: string;
  request: RequestItem;
}

export function RequestEditor({ collectionId, request }: Props) {
  const [tab, setTab] = useState<Tab>("params");
  const [showHistory, setShowHistory] = useState(false);
  const isServer = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.storage.kind === "server");
  const running = useStore((s) => s.running[request.id]);
  const key = draftKey(useStore.getState().activeWorkspaceId, "request", request.id);
  const dirty = useStore((s) => Boolean(s.drafts[key]));
  // Edits become a draft; Save (Ctrl+S) copies it into the workspace and syncs.
  const update = (patch: Partial<RequestItem>) =>
    useStore.getState().editDraft({ kind: "request", collectionId, id: request.id, value: { ...request, ...patch } });

  /** Moves a query string typed or pasted into the URL over to the Params table. */
  const normalizeUrl = () => {
    const current = request.url;
    if (!current.includes("?")) return;
    const { base, params } = splitUrl(current);
    update({ url: base, params: [...request.params, ...params] });
  };

  const send = () => {
    if (running) return;
    normalizeUrl();
    runRequest(collectionId, request.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onUrlPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted.includes("?")) return;
    e.preventDefault();
    const el = e.currentTarget;
    const raw = el.value.slice(0, el.selectionStart ?? 0) + pasted + el.value.slice(el.selectionEnd ?? 0);
    const { base, params } = splitUrl(raw);
    update({ url: base, params: [...request.params, ...params] });
    setTab("params");
  };

  const count = (n: number) => (n ? <span className="count">{n}</span> : null);
  const enabled = (list: { enabled: boolean; key: string }[]) => list.filter((x) => x.enabled && x.key).length;

  return (
    <div className="editor">
      <div className="editor-head">
        <div className="row">
          <input className="input bare" style={{ fontSize: 15, fontWeight: 600, flex: 1 }} value={request.name} aria-label="Request name" onChange={(e) => update({ name: e.target.value })} />
          {isServer && (
            <button className="btn ghost" title="Saved versions of this request" onClick={() => setShowHistory(true)}>
              History
            </button>
          )}
          <SaveControls draftKeyValue={key} dirty={dirty} />
        </div>
        <div className="urlbar">
          <select
            className={`select method-${request.method}`}
            value={request.method}
            aria-label="HTTP method"
            onChange={(e) => update({ method: e.target.value as HttpMethod })}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="https://api.example.com/resource  ·  use {{variables}}"
            value={request.url}
            aria-label="URL"
            onChange={(e) => update({ url: e.target.value })}
            onPaste={onUrlPaste}
            onBlur={normalizeUrl}
          />
          <button className="btn primary" onClick={send} disabled={running} title="Send (Ctrl+Enter)">
            {running ? "Sending…" : "Send"}
          </button>
        </div>
      </div>

      {showHistory && <HistoryModal target={{ kind: "request", collectionId, item: request }} onClose={() => setShowHistory(false)} />}
      <div className="split">
        <section className="pane">
          <nav className="tabs" role="tablist">
            <TabBtn id="params" tab={tab} setTab={setTab}>Params{count(enabled(request.params))}</TabBtn>
            <TabBtn id="headers" tab={tab} setTab={setTab}>Headers{count(enabled(request.headers))}</TabBtn>
            <TabBtn id="body" tab={tab} setTab={setTab}>Body{request.body.mode !== "none" && <span className="count">●</span>}</TabBtn>
            <TabBtn id="auth" tab={tab} setTab={setTab}>Auth</TabBtn>
            <TabBtn id="pre" tab={tab} setTab={setTab}>Pre-request{request.scripts.preRequest.trim() && <span className="count">●</span>}</TabBtn>
            <TabBtn id="tests" tab={tab} setTab={setTab}>Tests{request.scripts.test.trim() && <span className="count">●</span>}</TabBtn>
            <TabBtn id="code" tab={tab} setTab={setTab}>Code</TabBtn>
          </nav>
          <div className="pane-body">
            {tab === "params" && <KeyValueTable rows={request.params} onChange={(params) => update({ params })} />}
            {tab === "headers" && <KeyValueTable rows={request.headers} onChange={(headers) => update({ headers })} keyPlaceholder="Header" />}
            {tab === "body" && <BodyEditor request={request} update={update} />}
            {tab === "auth" && <AuthEditor auth={request.auth} onChange={(auth) => update({ auth })} />}
            {tab === "pre" && (
              <ScriptEditor kind="preRequest" value={request.scripts.preRequest} onChange={(preRequest) => update({ scripts: { ...request.scripts, preRequest } })} />
            )}
            {tab === "tests" && <ScriptEditor kind="test" value={request.scripts.test} onChange={(test) => update({ scripts: { ...request.scripts, test } })} />}
            {tab === "code" && <CodeView collectionId={collectionId} request={request} />}
          </div>
        </section>
        <ResponseViewer requestId={request.id} />
      </div>
    </div>
  );
}

function TabBtn({ id, tab, setTab, children }: { id: Tab; tab: Tab; setTab(t: Tab): void; children: React.ReactNode }) {
  return (
    <button className={`tab ${tab === id ? "active" : ""}`} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
      {children}
    </button>
  );
}

function BodyEditor({ request, update }: { request: RequestItem; update(p: Partial<RequestItem>): void }) {
  const body = request.body;
  const setMode = (mode: BodyMode) => update({ body: { ...body, mode } });
  const jsonError = useMemo(() => {
    if (body.mode !== "json" || !body.raw.trim()) return undefined;
    try {
      // Variables are often unquoted placeholders, so swap them for a literal before validating.
      JSON.parse(body.raw.replace(/\{\{[^{}]+\}\}/g, "0"));
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }, [body.mode, body.raw]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        {(["none", "json", "raw", "form-urlencoded", "form-data"] as BodyMode[]).map((m) => (
          <label key={m} className="row" style={{ gap: 4, marginRight: 8 }}>
            <input type="radio" name="body-mode" checked={body.mode === m} onChange={() => setMode(m)} />
            {m}
          </label>
        ))}
        <span className="spacer" />
        {body.mode === "json" && (
          <button
            className="btn"
            disabled={!!jsonError}
            onClick={() => update({ body: { ...body, raw: JSON.stringify(JSON.parse(body.raw), null, 2) } })}
          >
            Beautify
          </button>
        )}
      </div>
      {["GET", "HEAD"].includes(request.method) && body.mode !== "none" && (
        <p className="hint warn">{request.method} requests are sent without a body.</p>
      )}
      {(body.mode === "json" || body.mode === "raw") && (
        <>
          <textarea className="code" spellCheck={false} value={body.raw} onChange={(e) => update({ body: { ...body, raw: e.target.value } })} />
          {jsonError && <p style={{ color: "var(--danger)", margin: "6px 0 0" }}>Invalid JSON: {jsonError}</p>}
        </>
      )}
      {(body.mode === "form-urlencoded" || body.mode === "form-data") && (
        <KeyValueTable rows={body.form} onChange={(form) => update({ body: { ...body, form } })} />
      )}
      {body.mode === "none" && <p className="muted">This request has no body.</p>}
    </div>
  );
}

function CodeView({ collectionId, request }: { collectionId: string; request: RequestItem }) {
  // Recomputed on every render so it follows edits and environment changes.
  const curl = exportCurl(previewRequest(collectionId, request.id));
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>cURL</strong>
        <span className="muted">variables resolved with the active environment</span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigator.clipboard.writeText(curl).then(() => toast("Copied"))}>
          Copy
        </button>
      </div>
      <pre className="code">{curl}</pre>
    </div>
  );
}
