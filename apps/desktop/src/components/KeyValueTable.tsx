import { keyValue, type KeyValue } from "@getman/core";

interface Props {
  rows: KeyValue[];
  onChange(rows: KeyValue[]): void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  readOnly?: boolean;
}

/** Editable key/value list. An empty trailing row is always shown to add new entries. */
export function KeyValueTable({ rows, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value", readOnly }: Props) {
  const ghost = keyValue();
  const display = readOnly ? rows : [...rows, ghost];

  const update = (id: string, patch: Partial<KeyValue>) => {
    if (id === ghost.id) onChange([...rows, { ...ghost, ...patch }]);
    else onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="check" />
          <th>{keyPlaceholder}</th>
          <th>{valuePlaceholder}</th>
          <th>Description</th>
          <th className="tools" />
        </tr>
      </thead>
      <tbody>
        {display.map((row) => {
          const isGhost = row.id === ghost.id;
          return (
            <tr key={row.id} className={row.enabled ? "" : "disabled"}>
              <td className="check">
                {!isGhost && (
                  <input
                    type="checkbox"
                    aria-label="Enabled"
                    checked={row.enabled}
                    disabled={readOnly}
                    onChange={(e) => update(row.id, { enabled: e.target.checked })}
                  />
                )}
              </td>
              <td>
                <input className="input" placeholder={keyPlaceholder} value={row.key} readOnly={readOnly} onChange={(e) => update(row.id, { key: e.target.value })} />
              </td>
              <td>
                <input className="input" placeholder={valuePlaceholder} value={row.value} readOnly={readOnly} onChange={(e) => update(row.id, { value: e.target.value })} />
              </td>
              <td>
                <input className="input" placeholder="" value={row.description ?? ""} readOnly={readOnly} onChange={(e) => update(row.id, { description: e.target.value })} />
              </td>
              <td className="tools">
                {!isGhost && !readOnly && (
                  <button className="btn ghost icon" title="Remove" aria-label="Remove row" onClick={() => onChange(rows.filter((r) => r.id !== row.id))}>
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
