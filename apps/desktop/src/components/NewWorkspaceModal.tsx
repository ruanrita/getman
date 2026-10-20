import { useState } from "react";
import { useStore } from "../lib/store";
import { createServerWorkspace } from "../lib/sync";
import { toast } from "../lib/ui";
import { Modal } from "./Modal";

export function NewWorkspaceModal({ onClose, onConnect }: { onClose(): void; onConnect(): void }) {
  const servers = useStore((s) => s.servers).filter((a) => a.token);
  const [name, setName] = useState("");
  const [where, setWhere] = useState<string>("local");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (where === "local") useStore.getState().addWorkspace(name.trim());
      else await createServerWorkspace(where, name.trim());
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New workspace"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>Create</button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 14, maxWidth: 480 }}>
        <label>
          Name
          <input className="input" style={{ width: "100%" }} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        </label>
        <div>
          <div style={{ marginBottom: 6 }}>Where</div>
          <label className="row" style={{ gap: 6, padding: "3px 0" }}>
            <input type="radio" checked={where === "local"} onChange={() => setWhere("local")} /> This device only
          </label>
          {servers.map((s) => (
            <label key={s.url} className="row" style={{ gap: 6, padding: "3px 0" }}>
              <input type="radio" checked={where === s.url} onChange={() => setWhere(s.url)} /> Shared on {new URL(s.url).host}
              <span className="muted">as {s.user?.email}</span>
            </label>
          ))}
          {servers.length === 0 && (
            <p className="muted">
              To share with a team,{" "}
              <button className="btn ghost" style={{ height: "auto", padding: 0, color: "var(--primary-strong)" }} onClick={onConnect}>
                connect to a Getman server
              </button>
              .
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
