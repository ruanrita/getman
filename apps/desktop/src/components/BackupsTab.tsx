import { useEffect, useState } from "react";
import { ApiError, type BackupRun, type BackupSchedule, type BackupTarget, type NewBackupTarget, type ServerApi } from "../lib/api";
import { loadServerWorkspace } from "../lib/sync";
import { useStore } from "../lib/store";
import { formatBytes, toast } from "../lib/ui";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

const SCHEDULES: Record<BackupSchedule, string> = { manual: "Manual only", hourly: "Every hour", daily: "Every day", weekly: "Every week" };
const KIND_LABEL: Record<BackupTarget["kind"], string> = { s3: "S3-compatible", local: "Server folder", postgres: "PostgreSQL" };

function saveBytes(filename: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BackupsTab({ wsId, api }: { wsId: string; api: ServerApi }) {
  const [data, setData] = useState<{ targets: BackupTarget[]; runs: BackupRun[]; localBackupsEnabled: boolean }>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string>();
  const load = () => api.backups(wsId).then(setData, (e) => toast(errorText(e)));
  useEffect(() => void load(), [wsId]);

  const act = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(undefined);
      void load();
    }
  };

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div>
      <p className="hint" style={{ marginBottom: 12 }}>
        Backups are encrypted with a passphrase you choose. They contain collections, environments, globals and the member list. Secret and local values are never included.
      </p>

      {data.targets.map((t) => {
        const runs = data.runs.filter((r) => r.targetId === t.id);
        return (
          <div key={t.id} className="section backup-target">
            <div className="row">
              <strong>{t.name}</strong>
              <span className="muted">
                {KIND_LABEL[t.kind]} · {SCHEDULES[t.schedule]} · keeps {t.retention}
              </span>
              <span className="spacer" />
              <label className="row muted" style={{ gap: 4 }}>
                <input type="checkbox" checked={t.enabled} onChange={(e) => act(t.id, () => api.updateBackupTarget(wsId, t.id, { enabled: e.target.checked }))} /> enabled
              </label>
              <select className="select" value={t.schedule} onChange={(e) => act(t.id, () => api.updateBackupTarget(wsId, t.id, { schedule: e.target.value as BackupSchedule }))}>
                {Object.entries(SCHEDULES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={busy === t.id} onClick={() => act(t.id, () => api.runBackup(wsId, t.id), "Backup finished")}>
                {busy === t.id ? "Running…" : "Back up now"}
              </button>
              <button
                className="btn danger"
                onClick={() => confirm(`Remove "${t.name}"? Files already written stay where they are.`) && act(t.id, () => api.deleteBackupTarget(wsId, t.id), "Target removed")}
              >
                Remove
              </button>
            </div>
            {t.lastStatus === "error" && <p className="hint warn" style={{ margin: "8px 0 0" }}>Last backup failed: {t.lastError}</p>}
            <table className="kv" style={{ marginTop: 8 }}>
              <tbody>
                {runs.slice(0, 8).map((r) => (
                  <tr key={r.id}>
                    <td style={{ padding: 6, width: 190 }} className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                    <td style={{ padding: 6, width: 80 }}>
                      {r.status === "ok" ? <span style={{ color: "var(--success)" }}>✓ ok</span> : r.status === "error" ? <span style={{ color: "var(--danger)" }} title={r.error ?? ""}>✗ failed</span> : "running"}
                    </td>
                    <td style={{ padding: 6 }} className="muted">{r.trigger}{r.sizeBytes ? ` · ${formatBytes(r.sizeBytes)}` : ""}</td>
                    <td className="tools" style={{ width: 230 }}>
                      {r.status === "ok" && (
                        <>
                          <button className="btn" onClick={() => act(r.id, async () => saveBytes(r.objectKey!, await api.downloadBackup(wsId, r.id)))}>
                            Download
                          </button>{" "}
                          <button
                            className="btn"
                            onClick={() => {
                              const restoreMembers = confirm("Restore into a NEW workspace (the current one is not changed).\n\nAlso add the members from the backup? OK = yes, Cancel = only me.");
                              void act(
                                r.id,
                                async () => {
                                  const res = await api.restoreRun(wsId, r.id, { restoreMembers });
                                  await loadServerWorkspace(api.url, res.id);
                                  useStore.getState().setActiveWorkspace(res.id);
                                },
                                "Restored into a new workspace",
                              );
                            }}
                          >
                            Restore
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td className="muted" style={{ padding: 6 }}>No backups yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        );
      })}

      {adding ? (
        <NewTarget wsId={wsId} api={api} localEnabled={data.localBackupsEnabled} onDone={() => (setAdding(false), void load())} />
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>
          + Add backup target
        </button>
      )}
    </div>
  );
}

function NewTarget({ wsId, api, localEnabled, onDone }: { wsId: string; api: ServerApi; localEnabled: boolean; onDone(): void }) {
  const [kind, setKind] = useState<NewBackupTarget["kind"]>("s3");
  const [name, setName] = useState("Nightly backup");
  const [schedule, setSchedule] = useState<BackupSchedule>("daily");
  const [retention, setRetention] = useState(14);
  const [passphrase, setPassphrase] = useState("");
  const [s3, setS3] = useState({ endpoint: "", region: "us-east-1", bucket: "", prefix: "getman/", accessKeyId: "", secretAccessKey: "" });
  const [folder, setFolder] = useState("backups");
  const [connectionString, setConnectionString] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const target = (): NewBackupTarget =>
    kind === "s3"
      ? { kind, config: { endpoint: s3.endpoint || undefined, region: s3.region, bucket: s3.bucket, prefix: s3.prefix }, secrets: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } }
      : kind === "local"
        ? { kind, config: { folder }, secrets: {} }
        : { kind, config: {}, secrets: { connectionString } };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(undefined);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, opts: { placeholder?: string; secret?: boolean } = {}) => (
    <label>
      {label}
      <input className="input mono" style={{ width: "100%" }} type={opts.secret ? "password" : "text"} value={value} placeholder={opts.placeholder} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <div className="section backup-target" style={{ display: "grid", gap: 10, maxWidth: 620 }}>
      <h4 style={{ margin: 0 }}>New backup target</h4>
      <div className="row" style={{ gap: 16 }}>
        {(["s3", "local", "postgres"] as const).map((k) => (
          <label key={k} className="row" style={{ gap: 4 }} title={k === "local" && !localEnabled ? "Disabled on this server (GETMAN_BACKUP_DIR not set)" : ""}>
            <input type="radio" checked={kind === k} disabled={k === "local" && !localEnabled} onChange={() => setKind(k)} /> {KIND_LABEL[k]}
          </label>
        ))}
      </div>
      {field("Name", name, setName)}

      {kind === "s3" && (
        <>
          {field("Endpoint (empty for AWS)", s3.endpoint, (v) => setS3({ ...s3, endpoint: v }), { placeholder: "https://s3.example.com · R2 · MinIO · B2" })}
          <div className="row">
            {field("Bucket", s3.bucket, (v) => setS3({ ...s3, bucket: v }))}
            {field("Region", s3.region, (v) => setS3({ ...s3, region: v }))}
            {field("Prefix", s3.prefix, (v) => setS3({ ...s3, prefix: v }))}
          </div>
          <div className="row">
            {field("Access key ID", s3.accessKeyId, (v) => setS3({ ...s3, accessKeyId: v }))}
            {field("Secret access key", s3.secretAccessKey, (v) => setS3({ ...s3, secretAccessKey: v }), { secret: true })}
          </div>
        </>
      )}
      {kind === "local" && field("Folder (inside the server's backup directory)", folder, setFolder)}
      {kind === "postgres" && field("Connection string", connectionString, setConnectionString, { placeholder: "postgres://user:pass@host:5432/db", secret: true })}

      <div className="row">
        <label>
          Schedule
          <select className="select" style={{ width: "100%" }} value={schedule} onChange={(e) => setSchedule(e.target.value as BackupSchedule)}>
            {Object.entries(SCHEDULES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Keep last
          <input className="input" type="number" min={1} max={1000} style={{ width: 90 }} value={retention} onChange={(e) => setRetention(Number(e.target.value))} />
        </label>
      </div>
      {field("Encryption passphrase (12+ characters)", passphrase, setPassphrase, { secret: true })}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Store this passphrase somewhere safe (a password manager). You need it to restore a downloaded backup file.
      </p>

      {msg && <p className={`hint ${msg.ok ? "" : "warn"}`} style={{ margin: 0 }}>{msg.text}</p>}
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => run(() => api.testBackupTarget(wsId, target()), "Connection works: a test file was written and removed.")}>
          Test connection
        </button>
        <button
          className="btn primary"
          disabled={busy || passphrase.length < 12 || !name.trim()}
          onClick={async () => {
            if (await run(() => api.createBackupTarget(wsId, { ...target(), name, schedule, retention, passphrase }), "Saved")) onDone();
          }}
        >
          Save target
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
