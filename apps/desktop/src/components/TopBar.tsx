import { useActiveWorkspace, useStore, type Theme } from "../lib/store";

export type ModalName = "environments" | "import" | "export";

const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

export function TopBar({ open }: { open(modal: ModalName): void }) {
  const ws = useActiveWorkspace();
  const workspaces = useStore((s) => s.workspaces);
  const theme = useStore((s) => s.theme);
  const { setActiveWorkspace, addWorkspace, setActiveEnvironment, setTheme } = useStore.getState();

  const onWorkspace = (id: string) => {
    if (id !== "__new__") return setActiveWorkspace(id);
    const name = prompt("Workspace name")?.trim();
    if (name) addWorkspace(name);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/getman.svg" alt="" />
        Getman
      </div>

      <select className="select" value={ws.id} aria-label="Workspace" onChange={(e) => onWorkspace(e.target.value)}>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        <option value="__new__">+ New workspace…</option>
      </select>
      <span className="muted" title="Storage mode. Server and Git modes are on the roadmap.">
        {ws.storage.kind === "local" ? "Local" : ws.storage.kind}
      </span>

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
      <button className="btn icon" title={`Theme: ${theme}`} aria-label="Toggle theme" onClick={() => setTheme(NEXT_THEME[theme])}>
        {THEME_ICON[theme]}
      </button>
    </header>
  );
}
