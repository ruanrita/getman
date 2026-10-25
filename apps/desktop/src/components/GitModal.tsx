import { useEffect, useState } from "react";
import { useActiveWorkspace } from "../lib/store";
import { commitAndPush, pull, refreshStatus, reloadFromDisk, useGit } from "../lib/gitSync";
import { Modal } from "./Modal";

const STATUS_LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "??": "new", U: "conflict" };

function describe(line: string) {
  const code = line.slice(0, 2).trim();
  const path = line.slice(3).replace(/^"|"$/g, "").replace(/^\.getman\//, "");
  return { label: STATUS_LABEL[code] ?? STATUS_LABEL[code[0] ?? ""] ?? code, path };
}

export function GitModal({ onClose }: { onClose(): void }) {
  const ws = useActiveWorkspace();
  const git = useGit((s) => s[ws.id]);
  const [message, setMessage] = useState("");
  const dir = ws.storage.kind === "git" ? ws.storage.dir : "";
  const st = git?.status;

  useEffect(() => {
    void refreshStatus(ws.id);
  }, [ws.id]);

  const changes = st?.changes ?? [];
  const canPush = changes.length > 0 || (st?.ahead ?? 0) > 0;

  return (
    <Modal title="Git" onClose={onClose}>
      <div style={{ display: "grid", gap: 12 }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="mono muted" title={dir}>{dir}</span>
          <span className="spacer" />
          <button className="btn" disabled={Boolean(git?.busy)} onClick={() => void reloadFromDisk(ws.id).then(() => refreshStatus(ws.id))}>
            Refresh
          </button>
        </div>

        {st && !st.isRepo && (
          <p className="hint warn" style={{ margin: 0 }}>
            This folder is not inside a Git repository. Run <code>git init</code> there (or choose a folder in a cloned repository) to commit and push. Getman still saves your changes to the folder.
          </p>
        )}
        {git?.error && <p className="hint warn" style={{ margin: 0 }}>{git.error}</p>}

        {st?.isRepo && (
          <div className="row" style={{ gap: 16 }}>
            <span>
              ⎇ <strong>{st.branch ?? "(no branch)"}</strong>
            </span>
            <span className="muted">{st.upstream ? `tracking ${st.upstream}` : "no upstream (first push will set it)"}</span>
            {st.ahead > 0 && <span style={{ color: "var(--primary-strong)" }}>↑ {st.ahead} to push</span>}
            {st.behind > 0 && <span style={{ color: "var(--warning)" }}>↓ {st.behind} to pull</span>}
          </div>
        )}

        {st?.isRepo && (
          <div className="section" style={{ margin: 0 }}>
            <h4>Changes in .getman ({changes.length})</h4>
            {changes.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>Nothing to commit.</p>
            ) : (
              <table className="kv">
                <tbody>
                  {changes.map((line) => {
                    const c = describe(line);
                    return (
                      <tr key={line}>
                        <td style={{ padding: 4, width: 90 }} className="muted">{c.label}</td>
                        <td className="mono" style={{ padding: 4 }}>{c.path}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {st?.isRepo && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void commitAndPush(ws.id, message).then((out) => out?.ok && setMessage(""));
            }}
          >
            <input className="input" style={{ flex: 1 }} placeholder="Commit message, e.g. Add payment endpoints" value={message} onChange={(e) => setMessage(e.target.value)} />
            <button className="btn primary" disabled={!canPush || !message.trim() || Boolean(git?.busy)}>
              {git?.busy === "Commit & push" ? "Pushing…" : "Commit & push"}
            </button>
            <button type="button" className="btn" disabled={Boolean(git?.busy)} onClick={() => void pull(ws.id)}>
              {git?.busy === "Pull" ? "Pulling…" : "Pull"}
            </button>
          </form>
        )}

        {git?.output && <pre className="code" style={{ minHeight: 0, maxHeight: 200 }}>{git.output}</pre>}

        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Only files in <code>.getman/</code> are committed. Authentication uses your Git setup (SSH agent or Git Credential Manager). Pull only fast-forwards: if
          the branches diverged, merge or rebase in your terminal, then click Refresh.
        </p>
      </div>
    </Modal>
  );
}
