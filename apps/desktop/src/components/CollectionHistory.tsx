import { useEffect, useState } from "react";
import { ApiError, type CollectionVersion } from "../lib/api";
import { useStore } from "../lib/store";
import { apiFor, loadServerWorkspace } from "../lib/sync";
import { toast } from "../lib/ui";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** Saved versions of a collection: who saved what, and restoring the whole collection. */
export function CollectionHistory({ wsId, url, collectionId }: { wsId: string; url: string; collectionId: string }) {
  const [versions, setVersions] = useState<CollectionVersion[]>();
  const canWrite = useStore((s) => s.remote[wsId]?.role !== "viewer");
  const api = apiFor(url);
  const load = () => api.collectionVersions(wsId, collectionId).then((r) => setVersions(r.versions), (e) => toast(errorText(e)));
  useEffect(() => void load(), [collectionId]);

  if (!versions) return <p className="muted">Loading…</p>;
  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Every save is a version. To bring back one request, open it and use <strong>History</strong> in its editor; to roll back everything, restore a version here
        (that creates a new version, so nothing is lost).
      </p>
      {versions.map((v, i) => (
        <div key={v.version} className="history-row">
          <div className="row">
            <strong>v{v.version}</strong>
            <span className="muted">
              {v.savedBy ?? "someone"} · {new Date(v.savedAt).toLocaleString()}
            </span>
            <span className="spacer" />
            {i > 0 && canWrite && (
              <button
                className="btn"
                onClick={() =>
                  confirm(`Restore the whole collection to version ${v.version}? Changes made after it will be undone (they stay in the history).`) &&
                  api.restoreCollectionVersion(wsId, collectionId, v.version).then(
                    async () => {
                      await loadServerWorkspace(url, wsId);
                      toast(`Restored to version ${v.version}`);
                      void load();
                    },
                    (e) => toast(errorText(e)),
                  )
                }
              >
                Restore this version
              </button>
            )}
            {i === 0 && <span className="muted">current</span>}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {v.changes.length === 0 && !v.settingsChanged && (i === versions.length - 1 ? "created" : "no request changes")}
            {v.settingsChanged && "collection settings changed"}
            {v.changes.map((c) => (
              <span key={c.id + c.change} className={`history-change ${c.change}`}>
                {c.change === "added" ? "+" : c.change === "deleted" ? "−" : "~"} {c.name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
