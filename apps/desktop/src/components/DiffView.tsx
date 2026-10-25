import { diffLines } from "../lib/diff";

/** Unified line diff of two YAML documents: red = only in `before`, green = only in `after`. */
export function DiffView({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const lines = diffLines(before.trimEnd(), after.trimEnd());
  const changed = lines.some((l) => l.type !== "same");
  return (
    <div>
      <div className="row muted" style={{ fontSize: 12, marginBottom: 6, gap: 16 }}>
        <span className="diff-legend del">− {beforeLabel}</span>
        <span className="diff-legend add">+ {afterLabel}</span>
      </div>
      {!changed ? (
        <p className="muted">No differences.</p>
      ) : (
        <pre className="code diff">
          {lines.map((l, i) => (
            <div key={i} className={`diff-line ${l.type}`}>
              <span className="diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
              {l.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
