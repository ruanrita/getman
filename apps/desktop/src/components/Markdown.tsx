import type { ReactNode } from "react";

/**
 * Minimal Markdown for assistant replies: fenced code, headings, lists,
 * paragraphs, inline code, bold, italics and links.
 *
 * Builds React elements only (never innerHTML): replies come from a model and
 * the desktop webview can reach native APIs, so no HTML from the model runs.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<CodeBlock key={key++} code={code.join("\n")} lang={fence[1]} />);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      blocks.push(<p key={key++} className="md-h">{inline(heading[2]!)}</p>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const children = items.map((it, n) => <li key={n}>{inline(it)}</li>);
      blocks.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}>{inline(para.join("\n"))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="md-code">
      <button className="btn ghost md-copy" onClick={() => navigator.clipboard.writeText(code)} title="Copy">
        Copy
      </button>
      {lang && <span className="md-lang">{lang}</span>}
      <pre className="code">{code}</pre>
    </div>
  );
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, n) => {
    if (!part) return null;
    if (part.startsWith("`")) return <code key={n}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={n}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={n}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      // Shown as text plus the target; nothing is opened automatically.
      return (
        <span key={n} title={link[2]}>
          {link[1]} <span className="muted">({link[2]})</span>
        </span>
      );
    }
    return part;
  });
}
