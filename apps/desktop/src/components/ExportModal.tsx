import { useState } from "react";
import { exportGetman, exportPostmanCollection, exportPostmanEnvironment } from "@getman/importers";
import { useActiveWorkspace } from "../lib/store";
import { downloadText, slug, toast } from "../lib/ui";
import { Modal } from "./Modal";

type Format = "getman-yaml" | "getman-json" | "postman";

export function ExportModal({ onClose }: { onClose(): void }) {
  const ws = useActiveWorkspace();
  const [format, setFormat] = useState<Format>("getman-yaml");
  const [collections, setCollections] = useState<Set<string>>(new Set(ws.collections.map((c) => c.id)));
  const [environments, setEnvironments] = useState<Set<string>>(new Set());

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const run = () => {
    const cols = ws.collections.filter((c) => collections.has(c.id));
    const envs = ws.environments.filter((e) => environments.has(e.id));
    if (format === "postman") {
      // Postman has one file per collection / environment.
      for (const c of cols) downloadText(`${slug(c.name)}.postman_collection.json`, JSON.stringify(exportPostmanCollection(c), null, 2));
      for (const e of envs) downloadText(`${slug(e.name)}.postman_environment.json`, JSON.stringify(exportPostmanEnvironment(e), null, 2));
    } else {
      const yaml = format === "getman-yaml";
      downloadText(
        `${slug(ws.name)}.getman.${yaml ? "yaml" : "json"}`,
        exportGetman({ collections: cols, environments: envs }, yaml ? "yaml" : "json"),
        yaml ? "application/yaml" : "application/json",
      );
    }
    toast("Export started");
    onClose();
  };

  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!collections.size && !environments.size} onClick={run}>Export</button>
        </>
      }
    >
      <div className="section">
        <h4>Format</h4>
        <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
          {(
            [
              ["getman-yaml", "Getman YAML (Git-friendly)"],
              ["getman-json", "Getman JSON"],
              ["postman", "Postman v2.1"],
            ] as [Format, string][]
          ).map(([id, label]) => (
            <label key={id} className="row" style={{ gap: 4 }}>
              <input type="radio" name="fmt" checked={format === id} onChange={() => setFormat(id)} /> {label}
            </label>
          ))}
        </div>
      </div>

      <div className="section">
        <h4>Collections</h4>
        {ws.collections.map((c) => (
          <label key={c.id} className="row" style={{ gap: 6, padding: "3px 0" }}>
            <input type="checkbox" checked={collections.has(c.id)} onChange={() => toggle(collections, c.id, setCollections)} /> {c.name}
          </label>
        ))}
      </div>

      <div className="section">
        <h4>Environments</h4>
        {ws.environments.length === 0 && <p className="muted">No environments.</p>}
        {ws.environments.map((e) => (
          <label key={e.id} className="row" style={{ gap: 6, padding: "3px 0" }}>
            <input type="checkbox" checked={environments.has(e.id)} onChange={() => toggle(environments, e.id, setEnvironments)} /> {e.name}
          </label>
        ))}
      </div>

      <p className="hint">🔒 Secret values and local values are never included in exports.</p>
    </Modal>
  );
}
