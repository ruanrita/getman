import { useState } from "react";
import { useStore } from "../lib/store";
import { apiFor, createServerWorkspace, loadServerWorkspace } from "../lib/sync";
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
          {where !== "local" && <RestoreFromFile url={where} onDone={onClose} />}
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

/** Disaster recovery: turn a downloaded .getman-backup file into a new server workspace. */
function RestoreFromFile({ url, onDone }: { url: string; onDone(): void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File>();
  const [passphrase, setPassphrase] = useState("");
  const [restoreMembers, setRestoreMembers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!open) {
    return (
      <button className="btn ghost" style={{ marginTop: 8, paddingLeft: 0, color: "var(--primary-strong)" }} onClick={() => setOpen(true)}>
        …or restore from a backup file
      </button>
    );
  }

  const restore = async () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await apiFor(url).restoreFile({ file: btoa(binary), passphrase, restoreMembers });
      await loadServerWorkspace(url, res.id);
      useStore.getState().setActiveWorkspace(res.id);
      toast(`Restored "${res.name}" (${res.collections} collections)`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section backup-target" style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <h4 style={{ margin: 0 }}>Restore from a backup file</h4>
      <input type="file" accept=".getman-backup" onChange={(e) => setFile(e.target.files?.[0])} />
      <input className="input" type="password" placeholder="Backup passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={restoreMembers} onChange={(e) => setRestoreMembers(e.target.checked)} /> Re-add members who have an account on this server
      </label>
      {error && <p className="hint warn" style={{ margin: 0 }}>{error}</p>}
      <button className="btn primary" style={{ justifySelf: "start" }} disabled={!file || !passphrase || busy} onClick={restore}>
        {busy ? "Restoring…" : "Restore as new workspace"}
      </button>
    </div>
  );
}
