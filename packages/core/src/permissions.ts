import type { Member, Role, Workspace } from "./model";

export type Action =
  | "workspace.read"
  | "workspace.delete"
  | "workspace.transferOwnership"
  | "workspace.settings"
  | "members.manage"
  | "collections.write"
  | "environments.write"
  | "requests.send"
  | "backup.manage"
  | "ai.configure";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const MIN_ROLE: Record<Action, Role> = {
  "workspace.read": "viewer",
  "requests.send": "viewer",
  "collections.write": "editor",
  "environments.write": "editor",
  "workspace.settings": "admin",
  "members.manage": "admin",
  "backup.manage": "admin",
  "ai.configure": "admin",
  "workspace.delete": "owner",
  "workspace.transferOwnership": "owner",
};

export function can(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[MIN_ROLE[action]];
}

export function memberRole(ws: Workspace, userId: string): Role | undefined {
  return ws.members.find((m) => m.userId === userId)?.role;
}

/**
 * Whether `actor` may change `target` to `newRole`.
 *
 * - Nobody can grant `owner` through this path (use transferOwnership).
 * - Owners can change anyone except themselves.
 * - Admins can manage editors/viewers and promote them to admin, but cannot
 *   change the owner or other admins.
 */
export function canChangeRole(actor: Member, target: Member, newRole: Role): boolean {
  if (newRole === "owner") return false;
  if (actor.userId === target.userId) return false;
  if (actor.role === "owner") return true;
  if (actor.role === "admin") return target.role !== "owner" && target.role !== "admin";
  return false;
}

/** Hands ownership to another member; the previous owner becomes admin. */
export function transferOwnership(ws: Workspace, fromUserId: string, toUserId: string): Workspace {
  const from = ws.members.find((m) => m.userId === fromUserId);
  const to = ws.members.find((m) => m.userId === toUserId);
  if (!from || from.role !== "owner") throw new Error("Only the owner can transfer ownership");
  if (!to) throw new Error("Target is not a member of this workspace");
  return {
    ...ws,
    members: ws.members.map((m) =>
      m.userId === toUserId ? { ...m, role: "owner" } : m.userId === fromUserId ? { ...m, role: "admin" } : m,
    ),
  };
}
