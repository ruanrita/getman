import { useState } from "react";
import { variable, type Variable } from "@getman/core";

interface Props {
  vars: Variable[];
  onChange(vars: Variable[]): void;
}

/**
 * Variables with the two-value model:
 * - "Shared value" is synced/exported (blank for secrets).
 * - "Local value" stays on this device and wins when set.
 */
export function VariablesTable({ vars, onChange }: Props) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const ghost = variable();

  const update = (id: string, patch: Partial<Variable>) => {
    if (id === ghost.id) onChange([...vars, { ...ghost, ...patch }]);
    else onChange(vars.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  };
  const toggleReveal = (id: string) =>
    setRevealed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="check" />
          <th>Variable</th>
          <th title="Synced to the team and included in exports. Always empty for secrets.">Shared value</th>
          <th title="Only stored on this device. Overrides the shared value. Scripts write here.">Local value</th>
          <th className="check" title="Secret: masked, never synced or exported">🔒</th>
          <th className="tools" />
        </tr>
      </thead>
      <tbody>
        {[...vars, ghost].map((v) => {
          const isGhost = v.id === ghost.id;
          const masked = v.secret && !revealed.has(v.id);
          return (
            <tr key={v.id} className={v.enabled ? "" : "disabled"}>
              <td className="check">
                {!isGhost && <input type="checkbox" aria-label="Enabled" checked={v.enabled} onChange={(e) => update(v.id, { enabled: e.target.checked })} />}
              </td>
              <td>
                <input className="input" placeholder="name" value={v.key} onChange={(e) => update(v.id, { key: e.target.value })} />
              </td>
              <td>
                <input
                  className="input"
                  placeholder={v.secret ? "not shared (secret)" : "shared value"}
                  value={v.secret ? "" : v.value}
                  disabled={v.secret}
                  onChange={(e) => update(v.id, { value: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input"
                  type={masked ? "password" : "text"}
                  placeholder="local value"
                  value={v.localValue ?? ""}
                  onChange={(e) => update(v.id, { localValue: e.target.value })}
                />
              </td>
              <td className="check">
                {!isGhost && (
                  <input
                    type="checkbox"
                    aria-label="Secret"
                    checked={v.secret}
                    // Turning a variable secret moves its shared value to the local value so it is never synced.
                    onChange={(e) =>
                      update(v.id, e.target.checked ? { secret: true, value: "", localValue: v.localValue || v.value } : { secret: false })
                    }
                  />
                )}
              </td>
              <td className="tools">
                {!isGhost && v.secret && (
                  <button className="btn ghost icon" title={masked ? "Show" : "Hide"} aria-label="Toggle visibility" onClick={() => toggleReveal(v.id)}>
                    {masked ? "👁" : "◌"}
                  </button>
                )}
                {!isGhost && (
                  <button className="btn ghost icon" title="Remove" aria-label="Remove variable" onClick={() => onChange(vars.filter((x) => x.id !== v.id))}>
                    ×
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
