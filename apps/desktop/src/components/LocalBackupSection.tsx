import { useEffect, useState } from "react";
import { backupFolder, backupNow, belongsTo, listBackups, localBackupsAvailable, openBackupFolder, restoreBackup, type BackupFileInfo } from "../lib/localBackup";
import { pickFolder } from "../lib/gitSync";
import { useActiveWorkspace, useStore } from "../lib/store";
import { formatBytes, toast } from "../lib/ui";

const ago = (ms: number) => {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : new Date(ms).toLocaleString();
};

/** Settings and recent backups of the current local workspace. */
export function LocalBackupSection() {
  const ws = useActiveWorkspace();
  const settings = useStore((s) => s.localBackup);
  const setLocalBackup = useStore((s) => s.setLocalBackup);
  const [dir, setDir] = useState<string>();
  const [files, setFiles] = useState<BackupFileInfo[]>([]);
  const load = async () => {
    setDir(await backupFolder());
    setFiles((await listBackups()).filter((f) => belongsTo(f.name, ws)));
  };
  useEffect(() => void load().catch(() => {}), [ws.id, settings.dir]);

  if (!localBackupsAvailable()) {
    return <p className="muted">Automatic backups are available in the desktop app.</p>;
  }
  const last = settings.last[ws.id];

  return (
    <div className="section backup-target" style={{ display: "grid", gap: 10 }}>
      <div className="row">
        <strong>Automatic backups</strong>
        <span className="spacer" />
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={settings.enabled} onChange={(e) => setLocalBackup({ enabled: e.target.checked })} /> on
        </label>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        Copies of this workspace (including unsaved changes; never secret or local values) are written to a folder, so reinstalling Getman or clearing its data
        cannot lose your work. Last backup: {last ? ago(last.at) : "never"}.
      </span>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="mono muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }} title={dir}>
          {dir}
        </span>
        <button
          className="btn"
          onClick={async () => {
            const picked = await pickFolder("Folder for Getman backups");
            if (picked) setLocalBackup({ dir: picked });
          }}
        >
          Change folder…
        </button>
        <button className="btn" onClick={() => openBackupFolder().catch((e) => toast(String(e)))}>
          Open folder
        </button>
        {settings.dir && (
          <button className="btn ghost" onClick={() => setLocalBackup({ dir: undefined })}>
            Use default folder
          </button>
        )}
      </div>
      <div className="row">
        <label className="row" style={{ gap: 6 }}>
          Every
          <select className="select" value={settings.intervalMin} onChange={(e) => setLocalBackup({ intervalMin: Number(e.target.value) })}>
            {[5, 10, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          when something changed, keep the last
          <input className="input" type="number" min={1} max={500} style={{ width: 70 }} value={settings.keep} onChange={(e) => setLocalBackup({ keep: Math.max(1, Number(e.target.value)) })} />
        </label>
        <span className="spacer" />
        <button
          className="btn primary"
          onClick={() =>
            backupNow(ws, true).then(
              (name) => (toast(`Backup written: ${name}`), void load()),
              (e) => toast(`Backup failed: ${e}`),
            )
          }
        >
          Back up now
        </button>
      </div>
      {files.length > 0 && (
        <table className="kv">
          <tbody>
            {files.slice(0, 8).map((f) => (
              <tr key={f.name}>
                <td style={{ padding: 4 }}>{new Date(f.modified).toLocaleString()}</td>
                <td className="muted" style={{ padding: 4 }}>{formatBytes(f.size)}</td>
                <td className="tools" style={{ width: 170 }}>
                  <button className="btn" title="Opens it as a new workspace; this one is not changed" onClick={() => restoreBackup(f.name).catch((e) => toast(String(e)))}>
                    Restore as copy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** In "New workspace": bring back any local backup, e.g. of a workspace that was deleted. */
export function RestoreLocalBackup({ onDone }: { onDone(): void }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<BackupFileInfo[]>();
  useEffect(() => {
    if (open) listBackups().then(setFiles, (e) => toast(String(e)));
  }, [open]);
  if (!open) {
    return (
      <button className="btn ghost" style={{ marginTop: 8, paddingLeft: 0, color: "var(--primary-strong)" }} onClick={() => setOpen(true)}>
        …or restore from an automatic backup
      </button>
    );
  }
  return (
    <div className="section backup-target" style={{ marginTop: 8, maxHeight: 260, overflow: "auto" }}>
      {!files && <p className="muted">Loading…</p>}
      {files?.length === 0 && <p className="muted">No backups in the backup folder yet.</p>}
      <table className="kv">
        <tbody>
          {files?.slice(0, 50).map((f) => (
            <tr key={f.name}>
              <td className="mono" style={{ padding: 4, fontSize: 12 }}>{f.name.replace(/^getman-/, "").replace(/-[0-9a-f]{8}-\d{8}-\d{6}\.getman\.yaml$/, "")}</td>
              <td className="muted" style={{ padding: 4 }}>{new Date(f.modified).toLocaleString()}</td>
              <td className="tools" style={{ width: 90 }}>
                <button className="btn" onClick={() => restoreBackup(f.name).then(onDone, (e) => toast(String(e)))}>
                  Restore
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
