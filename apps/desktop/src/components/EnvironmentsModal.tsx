import { useState } from "react";
import { newEnvironment } from "@getman/core";
import { useActiveWorkspace, useStore } from "../lib/store";
import { Modal } from "./Modal";
import { VariablesTable } from "./VariablesTable";

const GLOBALS = "__globals__";

export function EnvironmentsModal({ onClose }: { onClose(): void }) {
  const ws = useActiveWorkspace();
  const { addEnvironment, updateEnvironment, removeEnvironment, setGlobals, setActiveEnvironment } = useStore.getState();
  const [selected, setSelected] = useState<string>(ws.activeEnvironmentId ?? ws.environments[0]?.id ?? GLOBALS);
  const env = ws.environments.find((e) => e.id === selected);

  const create = () => {
    const e = newEnvironment();
    addEnvironment(e);
    setSelected(e.id);
  };

  return (
    <Modal title="Environments" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="envs">
        <div className="env-list">
          <button className={`btn ghost ${selected === GLOBALS ? "primary" : ""}`} onClick={() => setSelected(GLOBALS)}>
            🌐 Globals
          </button>
          <hr style={{ border: 0, borderTop: "1px solid var(--border)", width: "100%" }} />
          {ws.environments.map((e) => (
            <button key={e.id} className={`btn ghost ${selected === e.id ? "primary" : ""}`} onClick={() => setSelected(e.id)}>
              {e.id === ws.activeEnvironmentId ? "● " : ""}
              {e.name}
            </button>
          ))}
          <button className="btn" style={{ marginTop: 8 }} onClick={create}>
            + New environment
          </button>
        </div>

        <div>
          {selected === GLOBALS && (
            <>
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
  );
}
