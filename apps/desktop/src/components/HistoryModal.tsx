import { useEffect, useState } from "react";
import type { Environment, RequestItem } from "@getman/core";
import { itemToYaml, variablesToYaml } from "@getman/importers";
import { ApiError, type ItemHistoryEntry } from "../lib/api";
import { useEffectiveWorkspace, useStore } from "../lib/store";
import { apiFor } from "../lib/sync";
import { toast } from "../lib/ui";
import { DiffView } from "./DiffView";
import { Modal } from "./Modal";

type Target = { kind: "request"; collectionId: string; item: RequestItem } | { kind: "environment"; env: Environment };

interface Entry {
  version: number;
  savedAt: string;
  savedBy: string | null;
  change: string;
  value: RequestItem | Environment | null;
}

/**
 * Versions of one request or environment (server workspaces). Pick one to
 * compare with what you have now; "Load into editor" turns it into a draft,
 * so restoring is just Save.
 */
export function HistoryModal({ target, onClose }: { target: Target; onClose(): void }) {
  const ws = useEffectiveWorkspace();
  const [entries, setEntries] = useState<Entry[]>();
  const [selected, setSelected] = useState(0);
  const url = ws.storage.kind === "server" ? ws.storage.url : "";

  useEffect(() => {
    const api = apiFor(url);
    const load =
      target.kind === "request"
        ? api.itemHistory(ws.id, target.collectionId, target.item.id).then((r) =>
            r.history.map((h: ItemHistoryEntry) => ({ ...h, value: h.item as RequestItem | null })),
          )
        : api.environmentVersions(ws.id, target.env.id).then((r) => r.versions.map((v) => ({ ...v, change: "saved", value: v.data })));
    load.then(setEntries, (e) => toast(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const current = target.kind === "request" ? itemToYaml(target.item) : variablesToYaml(target.env.name, target.env.variables);
  const entry = entries?.[selected];
  const old = entry?.value
    ? target.kind === "request"
      ? itemToYaml(entry.value as RequestItem)
      : variablesToYaml((entry.value as Environment).name, (entry.value as Environment).variables)
    : "(deleted)\n";

  const loadIntoEditor = () => {
    if (!entry?.value) return;
    const { editDraft } = useStore.getState();
    if (target.kind === "request") editDraft({ kind: "request", collectionId: target.collectionId, id: target.item.id, value: { ...(entry.value as RequestItem), id: target.item.id } });
    else {
      // Keep this device's local values; history never stores them.
      const env = entry.value as Environment;
      const variables = env.variables.map((v) => ({ ...v, localValue: target.env.variables.find((x) => x.key === v.key)?.localValue }));
      editDraft({ kind: "environment", id: target.env.id, value: { ...env, id: target.env.id, variables } });
    }
    toast(`Version ${entry.version} loaded as an unsaved draft. Save to make it current.`);
    onClose();
  };

  const title = target.kind === "request" ? target.item.name : target.env.name;
  return (
    <Modal title={`History · ${title}`} onClose={onClose}>
      {!entries && <p className="muted">Loading…</p>}
      {entries?.length === 0 && <p className="muted">No saved versions yet.</p>}
      {entries && entries.length > 0 && (
        <div className="history">
          <div className="history-list">
            {entries.map((e, i) => (
              <button key={e.version} className={`btn ghost history-item ${i === selected ? "selected" : ""}`} onClick={() => setSelected(i)}>
                <strong>v{e.version}</strong> {e.change}
                <span className="muted">
                  {e.savedBy ?? "someone"} · {new Date(e.savedAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
          <div>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="muted">Changes from version {entry?.version} to what you have now</span>
              <span className="spacer" />
              <button className="btn primary" disabled={!entry?.value} onClick={loadIntoEditor}>
                Load into editor
              </button>
            </div>
            <DiffView before={old} after={current} beforeLabel={`Version ${entry?.version}`} afterLabel="Now (including unsaved changes)" />
          </div>
        </div>
      )}
    </Modal>
  );
}
