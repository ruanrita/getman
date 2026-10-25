import { useGit } from "../lib/gitSync";
import { useActiveWorkspace, useStore, type Theme } from "../lib/store";

export type ModalName = "environments" | "import" | "export" | "account" | "workspace" | "newWorkspace" | "git";

const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const STATUS_LABEL = { synced: "● Synced", syncing: "◌ Syncing…", offline: "○ Offline", error: "▲ Sync error" } as const;

export function TopBar({ open }: { open(modal: ModalName): void }) {
  const ws = useActiveWorkspace();
  const workspaces = useStore((s) => s.workspaces);
  const meta = useStore((s) => s.remote[ws.id]);
  const signedIn = useStore((s) => s.servers.some((a) => a.token));
  const theme = useStore((s) => s.theme);
  const aiOpen = useStore((s) => s.aiOpen);
  const { setActiveWorkspace, setActiveEnvironment, setTheme, toggleAi } = useStore.getState();

  const gitState = useGit((s) => s[ws.id]);
  const local = workspaces.filter((w) => w.storage.kind === "local");
  const gitList = workspaces.filter((w) => w.storage.kind === "git");
  const byServer = new Map<string, typeof workspaces>();
  for (const w of workspaces) {
    if (w.storage.kind !== "server") continue;
    const host = new URL(w.storage.url).host;
    byServer.set(host, [...(byServer.get(host) ?? []), w]);
  }

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/getman.svg" alt="" />
        Getman
      </div>

      <select
        className="select"
        value={ws.id}
        aria-label="Workspace"
        onChange={(e) => (e.target.value === "__new__" ? open("newWorkspace") : setActiveWorkspace(e.target.value))}
      >
        <optgroup label="This device">
          {local.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </optgroup>
        {gitList.length > 0 && (
          <optgroup label="Git folders">
            {gitList.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </optgroup>
        )}
        {[...byServer].map(([host, list]) => (
          <optgroup key={host} label={host}>
            {list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="__new__">+ New workspace…</option>
      </select>
      <button className="btn ghost" onClick={() => open("workspace")} title="Workspace settings and members">
        ⚙
      </button>
      {ws.storage.kind === "git" ? (
        <button className="btn ghost" onClick={() => open("git")} title={gitState?.error ?? ws.storage.dir} style={gitState?.error ? { color: "var(--danger)" } : undefined}>
          ⎇ {gitState?.status?.branch ?? "git"}
          {gitState?.error ? " · ▲ problem" : gitState?.status?.changes.length ? ` · ${gitState.status.changes.length} change${gitState.status.changes.length === 1 ? "" : "s"}` : ""}
          {gitState?.status?.ahead ? ` · ↑${gitState.status.ahead}` : ""}
          {gitState?.status?.behind ? ` · ↓${gitState.status.behind}` : ""}
        </button>
      ) : meta ? (
        <span className="muted" title={meta.error ?? `Role: ${meta.role}`} style={meta.status === "error" ? { color: "var(--danger)" } : undefined}>
          {STATUS_LABEL[meta.status]} · {meta.role}
        </span>
      ) : (
        <span className="muted" title="Stored only on this device">Local</span>
      )}

      <span className="spacer" />

      <select
        className="select"
        aria-label="Active environment"
        value={ws.activeEnvironmentId ?? ""}
        onChange={(e) => setActiveEnvironment(e.target.value || undefined)}
      >
        <option value="">No environment</option>
        {ws.environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => open("environments")}>Environments</button>
      <button className="btn" onClick={() => open("import")}>Import</button>
      <button className="btn" onClick={() => open("export")}>Export</button>
      <button className={`btn ${aiOpen ? "primary" : ""}`} onClick={() => toggleAi()} title="Ask the assistant about Getman">
        ✦ Ask AI
      </button>
      <button className="btn" onClick={() => open("account")} title="Servers, sign-in, 2FA">
        {signedIn ? "Account" : "Sign in"}
      </button>
      <button className="btn icon" title={`Theme: ${theme}`} aria-label="Toggle theme" onClick={() => setTheme(NEXT_THEME[theme])}>
        {THEME_ICON[theme]}
      </button>
    </header>
  );
}
