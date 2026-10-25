import { useState } from "react";
import { newEnvironment } from "@getman/core";
import { draftKey } from "../lib/drafts";
import { useEffectiveWorkspace, useStore } from "../lib/store";
import { HistoryModal } from "./HistoryModal";
import { SaveControls } from "./SaveControls";
import { Modal } from "./Modal";
import { VariablesTable } from "./VariablesTable";

const GLOBALS = "__globals__";

export function EnvironmentsModal({ onClose }: { onClose(): void }) {
  const ws = useEffectiveWorkspace();
  const drafts = useStore((s) => s.drafts);
  const { addEnvironment, removeEnvironment, setActiveEnvironment, editDraft } = useStore.getState();
  // Edits are drafts until saved, like requests.
  const updateEnvironment = (id: string, fn: (e: (typeof ws.environments)[number]) => (typeof ws.environments)[number]) => {
    const current = ws.environments.find((e) => e.id === id);
    if (current) editDraft({ kind: "environment", id, value: fn(current) });
  };
  const setGlobals = (value: typeof ws.globals) => editDraft({ kind: "globals", id: "globals", value });
  const keyOf = (id: string) => (id === GLOBALS ? draftKey(ws.id, "globals", "globals") : draftKey(ws.id, "environment", id));
  const [selected, setSelected] = useState<string>(ws.activeEnvironmentId ?? ws.environments[0]?.id ?? GLOBALS);
  const [historyFor, setHistoryFor] = useState<string>();
  const historyEnv = ws.environments.find((e) => e.id === historyFor);
  const env = ws.environments.find((e) => e.id === selected);

  const create = () => {
    const e = newEnvironment();
    addEnvironment(e);
    setSelected(e.id);
  };

  return (
    <>
    {historyEnv && <HistoryModal target={{ kind: "environment", env: historyEnv }} onClose={() => setHistoryFor(undefined)} />}
    <Modal title="Environments" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="envs">
        <div className="env-list">
          <button className={`btn ghost ${selected === GLOBALS ? "primary" : ""}`} onClick={() => setSelected(GLOBALS)}>
            🌐 Globals{drafts[keyOf(GLOBALS)] ? " ●" : ""}
          </button>
          <hr style={{ border: 0, borderTop: "1px solid var(--border)", width: "100%" }} />
          {ws.environments.map((e) => (
            <button key={e.id} className={`btn ghost ${selected === e.id ? "primary" : ""}`} onClick={() => setSelected(e.id)}>
              {e.id === ws.activeEnvironmentId ? "✓ " : ""}
              {e.name}
              {drafts[keyOf(e.id)] ? <span className="unsaved-mark"> ●</span> : null}
            </button>
          ))}
          <button className="btn" style={{ marginTop: 8 }} onClick={create}>
            + New environment
          </button>
        </div>

        <div>
          {selected === GLOBALS && (
            <>
              <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
                <SaveControls draftKeyValue={keyOf(GLOBALS)} dirty={Boolean(drafts[keyOf(GLOBALS)])} />
              </div>
              <p className="hint" style={{ marginBottom: 12 }}>
                Globals apply to every collection in this workspace. Lowest precedence: environment and collection variables override them.
              </p>
              <VariablesTable vars={ws.globals} onChange={setGlobals} />
            </>
          )}
          {env && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <input
                  className="input"
                  style={{ flex: 1, fontWeight: 600 }}
                  value={env.name}
                  aria-label="Environment name"
                  onChange={(e) => updateEnvironment(env.id, (x) => ({ ...x, name: e.target.value }))}
                />
                {ws.storage.kind === "server" && (
                  <button className="btn ghost" onClick={() => setHistoryFor(env.id)}>
                    History
                  </button>
                )}
                <SaveControls draftKeyValue={keyOf(env.id)} dirty={Boolean(drafts[keyOf(env.id)])} />
                {ws.activeEnvironmentId !== env.id ? (
                  <button className="btn" onClick={() => setActiveEnvironment(env.id)}>
                    Set active
                  </button>
                ) : (
                  <span className="muted">Active</span>
                )}
                <button
                  className="btn danger"
                  onClick={() => {
                    if (!confirm(`Delete environment "${env.name}"?`)) return;
                    removeEnvironment(env.id);
                    setSelected(GLOBALS);
                  }}
                >
                  Delete
                </button>
              </div>
              <VariablesTable vars={env.variables} onChange={(variables) => updateEnvironment(env.id, (x) => ({ ...x, variables }))} />
              <p className="muted" style={{ marginTop: 10 }}>
                Values set by scripts (<code>pm.environment.set</code>) go to <strong>Local value</strong>, so tokens never reach your team or exports.
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
    </>
  );
}
