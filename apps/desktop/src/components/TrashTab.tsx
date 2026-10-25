import { useEffect, useState } from "react";
import { can, type Role } from "@getman/core";
import { ApiError, type ServerApi, type TrashEntry } from "../lib/api";
import { loadServerWorkspace } from "../lib/sync";
import { toast } from "../lib/ui";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const KIND: Record<TrashEntry["kind"], string> = { collection: "Collection", environment: "Environment", request: "Request", folder: "Folder" };

/** Deleted collections, folders, requests and environments (server workspaces), restorable for 30 days. */
export function TrashTab({ wsId, api, role }: { wsId: string; api: ServerApi; role: Role }) {
  const [data, setData] = useState<{ items: TrashEntry[]; retentionDays: number }>();
  const load = () => api.trash(wsId).then(setData, (e) => toast(errorText(e)));
  useEffect(() => void load(), [wsId]);

  const restore = (t: TrashEntry) =>
    api.restoreTrash(wsId, t.id).then(
      async () => {
        await loadServerWorkspace(api.url, wsId);
        toast(`${KIND[t.kind]} "${t.name}" restored`);
        void load();
      },
      (e) => toast(errorText(e)),
    );

  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Deleted items stay here for {data.retentionDays} days. Restoring puts a request or folder back where it was (or at the top of its collection if that folder is gone).
      </p>
      {data.items.length === 0 ? (
        <p className="muted">The trash is empty.</p>
      ) : (
        <table className="kv">
          <tbody>
            {data.items.map((t) => (
              <tr key={t.id}>
                <td style={{ padding: 6, width: 100 }} className="muted">{KIND[t.kind]}</td>
                <td style={{ padding: 6 }}>
                  <strong>{t.name}</strong>
                  {t.collectionName && <span className="muted"> · in {t.collectionName}</span>}
                </td>
                <td className="muted" style={{ padding: 6 }}>
                  {t.deletedBy ?? "someone"} · {new Date(t.deletedAt).toLocaleString()}
                </td>
                <td className="tools" style={{ width: 200 }}>
                  {can(role, t.kind === "environment" ? "environments.write" : "collections.write") && (
                    <button className="btn" onClick={() => restore(t)}>
                      Restore
                    </button>
                  )}{" "}
                  {can(role, "members.manage") && (
                    <button
                      className="btn danger"
                      onClick={() => confirm(`Delete "${t.name}" forever? This cannot be undone.`) && api.purgeTrash(wsId, t.id).then(load, (e) => toast(errorText(e)))}
                    >
                      Delete forever
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
