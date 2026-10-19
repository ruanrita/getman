import { useRef } from "react";

const SNIPPETS: Record<"preRequest" | "test", { label: string; code: string }[]> = {
  preRequest: [
    { label: "Set env variable", code: 'pm.environment.set("key", "value");' },
    { label: "Timestamp variable", code: 'pm.variables.set("now", new Date().toISOString());' },
    { label: "Add header", code: 'pm.request.headers.add({ key: "X-Custom", value: "value" });' },
    {
      label: "Fetch token first",
      code: [
        'const res = await pm.sendRequest({',
        '  url: pm.variables.replaceIn("{{baseUrl}}/auth"),',
        '  method: "POST",',
        '  header: [{ key: "Content-Type", value: "application/json" }],',
        '  body: { raw: JSON.stringify({ user: "demo" }) },',
        "});",
        'pm.environment.set("token", res.json().token);',
      ].join("\n"),
    },
  ],
  test: [
    { label: "Status is 200", code: 'pm.test("status is 200", () => pm.response.to.have.status(200));' },
    { label: "Response time", code: 'pm.test("faster than 500ms", () => pm.expect(pm.response.responseTime).to.be.below(500));' },
    { label: "JSON value check", code: 'pm.test("has id", () => {\n  const body = pm.response.json();\n  pm.expect(body).to.have.property("id");\n});' },
    { label: "Save to env", code: 'pm.environment.set("token", pm.response.json().token);' },
    { label: "Header exists", code: 'pm.test("content-type", () => pm.response.to.have.header("Content-Type"));' },
  ],
};

interface Props {
  kind: "preRequest" | "test";
  value: string;
  onChange(code: string): void;
}

export function ScriptEditor({ kind, value, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const insert = (code: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const before = value.slice(0, at);
    const sep = before && !before.endsWith("\n") ? "\n" : "";
    onChange(`${before}${sep}${code}\n${value.slice(at)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    onChange(`${value.slice(0, s)}  ${value.slice(end)}`);
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div>
      <div className="snippets">
        {SNIPPETS[kind].map((s) => (
          <button key={s.label} className="btn" onClick={() => insert(s.code)}>
            + {s.label}
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        className="code"
        spellCheck={false}
        style={{ minHeight: 220 }}
        placeholder={kind === "preRequest" ? "// Runs before the request is sent" : "// Runs after the response arrives"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="muted" style={{ marginTop: 6 }}>
        Postman-compatible <code>pm.*</code> API. Scripts run isolated with a 10s limit. See <code>docs/features/scripts.md</code>.
      </p>
    </div>
  );
}
