import type { Auth } from "@getman/core";

interface Props {
  auth: Auth;
  onChange(auth: Auth): void;
  /** Collections have no parent to inherit from. */
  allowInherit?: boolean;
}

const DEFAULTS: Record<Auth["type"], Auth> = {
  inherit: { type: "inherit" },
  none: { type: "none" },
  bearer: { type: "bearer", token: "" },
  basic: { type: "basic", username: "", password: "" },
  apikey: { type: "apikey", key: "X-API-Key", value: "", in: "header" },
};

export function AuthEditor({ auth, onChange, allowInherit = true }: Props) {
  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
      <label className="row">
        <span style={{ width: 90 }}>Type</span>
        <select className="select" value={auth.type} onChange={(e) => onChange(DEFAULTS[e.target.value as Auth["type"]])}>
          {allowInherit && <option value="inherit">Inherit from parent</option>}
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
          <option value="apikey">API key</option>
        </select>
      </label>

      {auth.type === "inherit" && <p className="muted">Uses the auth of the parent folder or collection.</p>}

      {auth.type === "bearer" && (
        <Field label="Token" value={auth.token} onChange={(token) => onChange({ ...auth, token })} placeholder="{{token}}" />
      )}

      {auth.type === "basic" && (
        <>
          <Field label="Username" value={auth.username} onChange={(username) => onChange({ ...auth, username })} />
          <Field label="Password" value={auth.password} onChange={(password) => onChange({ ...auth, password })} secret />
        </>
      )}

      {auth.type === "apikey" && (
        <>
          <Field label="Key" value={auth.key} onChange={(key) => onChange({ ...auth, key })} />
          <Field label="Value" value={auth.value} onChange={(value) => onChange({ ...auth, value })} placeholder="{{apiKey}}" />
          <label className="row">
            <span style={{ width: 90 }}>Add to</span>
            <select className="select" value={auth.in} onChange={(e) => onChange({ ...auth, in: e.target.value as "header" | "query" })}>
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </label>
        </>
      )}

      {auth.type !== "inherit" && auth.type !== "none" && (
        <p className="hint">Tip: use a secret variable like <code>{"{{token}}"}</code> instead of pasting credentials here, so they are never shared or exported.</p>
      )}
    </div>
  );
}

function Field(props: { label: string; value: string; onChange(v: string): void; placeholder?: string; secret?: boolean }) {
  return (
    <label className="row">
      <span style={{ width: 90 }}>{props.label}</span>
      <input
        className="input mono"
        style={{ flex: 1 }}
        type={props.secret ? "password" : "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
