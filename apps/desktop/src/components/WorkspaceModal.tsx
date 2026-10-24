import { useEffect, useState } from "react";
import { can, canChangeRole, type Role } from "@getman/core";
import { ApiError, type ServerApi } from "../lib/api";
import { useActiveWorkspace, useStore } from "../lib/store";
import { apiFor, loadServerWorkspace, publishWorkspace } from "../lib/sync";
import { toast } from "../lib/ui";
import { BackupsTab } from "./BackupsTab";
import { Modal } from "./Modal";
import { WorkspaceAiTab } from "./WorkspaceAiTab";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including deleting the workspace",
  admin: "Manage members, settings and backups",
  editor: "Edit collections and environments",
  viewer: "Read and send requests",
};

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

/** Settings of the active workspace. Server workspaces get members, 2FA policy and audit log. */
export function WorkspaceModal({ onClose }: { onClose(): void }) {
  const ws = useActiveWorkspace();
  const meta = useStore((s) => s.remote[ws.id]);
  const servers = useStore((s) => s.servers).filter((a) => a.token);
  const { renameWorkspace, removeWorkspace } = useStore.getState();
  const [tab, setTab] = useState<"general" | "members" | "backups" | "ai" | "audit">("general");
  const isServer = ws.storage.kind === "server";
  const role = meta?.role ?? "owner";

  return (
    <Modal title={`Workspace · ${ws.name}`} onClose={onClose}>
      {isServer && (
        <nav className="tabs" style={{ margin: "-16px -16px 16px" }}>
          {(["general", "members", "backups", "ai", "audit"] as const)
            .filter(
              (t) =>
                (t !== "audit" || can(role, "members.manage")) && (t !== "backups" || can(role, "backup.manage")) && (t !== "ai" || can(role, "ai.configure")),
            )
            .map((t) => (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {{ general: "General", members: `Members (${meta?.members.length ?? 0})`, backups: "Backups", ai: "AI assistant", audit: "Audit log" }[t]}
              </button>
            ))}
        </nav>
      )}

      {tab === "general" && (
        <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
          <label>
            Name
            <input
              className="input"
              style={{ width: "100%" }}
              value={ws.name}
              disabled={isServer && !can(role, "workspace.settings")}
              onChange={(e) => renameWorkspace(e.target.value)}
            />
          </label>

          {isServer ? (
            <ServerGeneral wsId={ws.id} api={apiFor(ws.storage.kind === "server" ? ws.storage.url : "")} onClose={onClose} />
          ) : (
            <>
              <div className="hint">This workspace is stored only on this device.</div>
              <div className="section">
                <h4>Share with your team</h4>
                {servers.length === 0 ? (
                  <p className="muted">Connect to a Getman server first (Servers & account).</p>
                ) : (
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    {servers.map((s) => (
                      <button
                        key={s.url}
                        className="btn"
                        onClick={() =>
                          publishWorkspace(ws.id, s.url).then(
                            () => (toast(`Published to ${new URL(s.url).host}`), onClose()),
                            (e) => toast(errorText(e)),
                          )
                        }
                      >
                        Publish to {new URL(s.url).host}
                      </button>
                    ))}
                  </div>
                )}
                <p className="muted" style={{ fontSize: 12 }}>
                  Creates a copy on the server that you own. Secrets and local values stay on this device. The local workspace is kept.
                </p>
              </div>
              <button
                className="btn danger"
                style={{ justifySelf: "start" }}
                onClick={() => confirm(`Delete "${ws.name}" from this device? This cannot be undone.`) && (removeWorkspace(ws.id), onClose())}
              >
                Delete workspace
              </button>
            </>
          )}
        </div>
      )}

      {tab === "members" && isServer && <Members wsId={ws.id} api={apiFor(ws.storage.kind === "server" ? ws.storage.url : "")} />}
      {tab === "backups" && isServer && <BackupsTab wsId={ws.id} api={apiFor(ws.storage.kind === "server" ? ws.storage.url : "")} />}
      {tab === "ai" && isServer && <WorkspaceAiTab wsId={ws.id} api={apiFor(ws.storage.kind === "server" ? ws.storage.url : "")} />}
      {tab === "audit" && isServer && <Audit wsId={ws.id} api={apiFor(ws.storage.kind === "server" ? ws.storage.url : "")} />}
    </Modal>
  );
}

function ServerGeneral({ wsId, api, onClose }: { wsId: string; api: ServerApi; onClose(): void }) {
  const meta = useStore((s) => s.remote[wsId])!;
  const me = useStore((s) => s.servers.find((a) => a.url === api.url)?.user);
  const role = meta.role;

  return (
    <>
      <div className="hint">
        Shared on <code>{api.url}</code>. Your role: <strong>{role}</strong> ({ROLE_HELP[role]}). Status: {meta.status}
        {meta.error ? ` (${meta.error})` : ""}.
      </div>

      {can(role, "workspace.settings") && (
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={meta.require2fa}
            onChange={(e) =>
              api.updateWorkspace(wsId, { require2fa: e.target.checked }).then(
                () => loadServerWorkspace(api.url, wsId),
                (err) => toast(errorText(err)),
              )
            }
          />
          Require two-factor authentication for every member
        </label>
      )}

      <div className="row">
        {role !== "owner" && me && (
          <button
            className="btn danger"
            onClick={() =>
              confirm("Leave this workspace? You will lose access until someone adds you again.") &&
              api.removeMember(wsId, me.id).then(
                () => (useStore.getState().removeWorkspace(wsId), onClose()),
                (e) => toast(errorText(e)),
              )
            }
          >
            Leave workspace
          </button>
        )}
        {can(role, "workspace.delete") && (
          <button
            className="btn danger"
            onClick={() => {
              const name = useStore.getState().workspaces.find((w) => w.id === wsId)?.name;
              if (prompt(`This deletes "${name}" for everyone. Type the workspace name to confirm.`) !== name) return;
              api.deleteWorkspace(wsId).then(
                () => (useStore.getState().removeWorkspace(wsId), onClose()),
                (e) => toast(errorText(e)),
              );
            }}
          >
            Delete for everyone
          </button>
        )}
      </div>
    </>
  );
}

function Members({ wsId, api }: { wsId: string; api: ServerApi }) {
  const meta = useStore((s) => s.remote[wsId])!;
  const me = useStore((s) => s.servers.find((a) => a.url === api.url)?.user);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("editor");
  const actor = meta.members.find((m) => m.userId === me?.id);
  const manage = can(meta.role, "members.manage");
  const refresh = () => loadServerWorkspace(api.url, wsId);
  const act = (p: Promise<unknown>, ok?: string) => p.then(refresh).then(() => ok && toast(ok), (e) => toast(errorText(e)));

  return (
    <div>
      {manage && (
        <form
          className="row"
          style={{ marginBottom: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            act(api.addMember(wsId, email, newRole), `${email} added`).then(() => setEmail(""));
          }}
        >
          <input className="input" style={{ flex: 1 }} type="email" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="select" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn primary">Add member</button>
        </form>
      )}
      {manage && <p className="muted" style={{ marginTop: -8 }}>They need an account on this server first.</p>}

      <table className="kv">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>2FA</th>
            <th className="tools" />
          </tr>
        </thead>
        <tbody>
          {meta.members.map((m) => {
            const editable = actor && (["admin", "editor", "viewer"] as Role[]).some((r) => r !== m.role && canChangeRole(actor, m, r));
            return (
              <tr key={m.userId}>
                <td style={{ padding: 6 }}>
                  {m.name} <span className="muted">· {m.email}</span>
                  {m.userId === me?.id && <strong className="muted"> (you)</strong>}
                </td>
                <td style={{ padding: 4 }}>
                  {editable ? (
                    <select className="select" value={m.role} onChange={(e) => act(api.changeRole(wsId, m.userId, e.target.value as Role))}>
                      {(["admin", "editor", "viewer"] as Role[]).map((r) => (
                        <option key={r} value={r} disabled={r !== m.role && !canChangeRole(actor!, m, r)}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span title={ROLE_HELP[m.role]}>{m.role}</span>
                  )}
                </td>
                <td style={{ padding: 6 }}>{m.totpEnabled ? "✓" : <span className="muted">–</span>}</td>
                <td className="tools" style={{ width: 230 }}>
                  {meta.role === "owner" && m.role !== "owner" && (
                    <button
                      className="btn"
                      onClick={() => confirm(`Make ${m.email} the owner? You will become an admin.`) && act(api.transfer(wsId, m.userId), "Ownership transferred")}
                    >
                      Make owner
                    </button>
                  )}{" "}
                  {manage && m.role !== "owner" && m.userId !== me?.id && !(meta.role === "admin" && m.role === "admin") && (
                    <button className="btn danger" onClick={() => confirm(`Remove ${m.email}?`) && act(api.removeMember(wsId, m.userId), "Member removed")}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Audit({ wsId, api }: { wsId: string; api: ServerApi }) {
  const [entries, setEntries] = useState<Awaited<ReturnType<ServerApi["audit"]>>["entries"]>([]);
  useEffect(() => void api.audit(wsId).then((r) => setEntries(r.entries), (e) => toast(errorText(e))), [wsId]);
  return (
    <table className="kv">
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td className="muted" style={{ padding: 6, whiteSpace: "nowrap" }}>{new Date(e.createdAt).toLocaleString()}</td>
            <td style={{ padding: 6 }}>{e.actorEmail ?? "deleted user"}</td>
            <td className="mono" style={{ padding: 6 }}>{e.action}</td>
            <td className="muted mono" style={{ padding: 6, fontSize: 12 }}>
              {Object.entries(e.details)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(" ")}
            </td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr>
            <td className="muted">No entries yet.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
