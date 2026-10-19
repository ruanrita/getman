import { useMemo, useState } from "react";
import { useStore } from "../lib/store";
import { formatBytes, toast } from "../lib/ui";

type Tab = "body" | "headers" | "tests" | "console";

function statusClass(status: number) {
  if (status < 300) return "ok";
  if (status < 400) return "redirect";
  if (status < 500) return "client";
  return "server";
}

export function ResponseViewer({ requestId }: { requestId: string }) {
  const result = useStore((s) => s.results[requestId]);
  const running = useStore((s) => s.running[requestId]);
  const [tab, setTab] = useState<Tab>("body");
  const [raw, setRaw] = useState(false);
  const res = result?.response;

  const pretty = useMemo(() => {
    if (!res) return "";
    const type = res.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    if (!raw && (type.includes("json") || /^\s*[[{]/.test(res.body))) {
      try {
        return JSON.stringify(JSON.parse(res.body), null, 2);
      } catch {
        // Not valid JSON: show as-is.
      }
    }
    return res.body;
  }, [res, raw]);

  const passed = result?.tests.filter((t) => t.passed).length ?? 0;
  const total = result?.tests.length ?? 0;
  const errors = result?.logs.filter((l) => l.level === "error").length ?? 0;

  return (
    <section className="pane" aria-label="Response">
      <nav className="tabs">
        {(["body", "headers", "tests", "console"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
            {t === "headers" && res && <span className="count">{res.headers.length}</span>}
            {t === "tests" && total > 0 && (
              <span className="count" style={{ color: passed === total ? "var(--success)" : "var(--danger)" }}>
                {passed}/{total}
              </span>
            )}
            {t === "console" && (result?.logs.length ?? 0) > 0 && (
              <span className="count" style={errors ? { color: "var(--danger)" } : undefined}>{result!.logs.length}</span>
            )}
          </button>
        ))}
        <span className="spacer" />
        {res && (
          <span className="status">
            <span className={`badge ${statusClass(res.status)}`}>
              {res.status} {res.statusText}
            </span>
            <span className="muted">{res.timeMs} ms</span>
            <span className="muted">{formatBytes(res.sizeBytes)}</span>
          </span>
        )}
      </nav>

      <div className="pane-body">
        {running && <p className="muted">Sending request…</p>}
        {!running && !result && <p className="muted">Send the request to see the response here.</p>}
        {!running && result?.error && (
          <div className="hint warn">
            <strong>Could not get a response.</strong> {result.error}
          </div>
        )}

        {!running && res && tab === "body" && (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <label className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Raw
              </label>
              <span className="spacer" />
              <button className="btn" onClick={() => navigator.clipboard.writeText(res.body).then(() => toast("Copied"))}>
                Copy
              </button>
            </div>
            <pre className="code">{pretty || <span className="muted">(empty body)</span>}</pre>
          </>
        )}

        {!running && res && tab === "headers" && (
          <table className="kv">
            <tbody>
              {res.headers.map(([k, v], i) => (
                <tr key={i}>
                  <td className="mono" style={{ width: "35%", padding: 6 }}>{k}</td>
                  <td className="mono" style={{ padding: 6, wordBreak: "break-all" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!running && result && tab === "tests" && (
          <>
            {total === 0 && <p className="muted">No tests ran. Add some in the Tests tab with <code>pm.test()</code>.</p>}
            {result.tests.map((t, i) => (
              <div key={i} className={`test ${t.passed ? "pass" : "fail"}`}>
                <span className="mark">{t.passed ? "PASS" : "FAIL"}</span>
                <div>
                  <div>{t.name}</div>
                  {t.error && <div className="muted mono">{t.error}</div>}
                </div>
                <span className="spacer" />
                <span className="muted">{t.source}</span>
              </div>
            ))}
          </>
        )}

        {!running && result && tab === "console" && (
          <>
            {result.logs.length === 0 && <p className="muted">Nothing logged. Use <code>console.log()</code> in scripts.</p>}
            {result.logs.map((l, i) => (
              <div key={i} className={`log ${l.level}`}>
                <span className="src">[{l.source}]</span>
                {l.message}
              </div>
            ))}
            {result.prepared && (
              <details style={{ marginTop: 12 }}>
                <summary className="muted">Request as sent</summary>
                <pre className="code">
                  {result.prepared.method} {result.prepared.url}
                  {"\n"}
                  {result.prepared.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}
                  {result.prepared.body?.kind === "text" ? `\n\n${result.prepared.body.text}` : ""}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
