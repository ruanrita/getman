import type { WebSocket } from "ws";

/**
 * In-process pub/sub for live workspace updates.
 *
 * Limitation: one server instance. Running several replicas needs a shared
 * bus (Postgres LISTEN/NOTIFY or Redis); see docs/architecture/storage.md.
 */
export type ServerEvent =
  | { type: "collection.put"; workspaceId: string; collection: unknown; version: number; by: string }
  | { type: "collection.deleted"; workspaceId: string; id: string; by: string }
  | { type: "environment.put"; workspaceId: string; environment: unknown; version: number; by: string }
  | { type: "environment.deleted"; workspaceId: string; id: string; by: string }
  | { type: "globals.put"; workspaceId: string; globals: unknown; version: number; by: string }
  | { type: "workspace.updated"; workspaceId: string; by: string }
  | { type: "members.updated"; workspaceId: string; by: string }
  | { type: "workspace.removed"; workspaceId: string; reason: "deleted" | "access_revoked" };

/** Sent to a user's sockets regardless of subscriptions. */
export type UserEvent = { type: "workspace.added"; workspaceId: string };

interface Client {
  socket: WebSocket;
  userId: string;
  sessionId: string;
  workspaces: Set<string>;
}

export class Hub {
  private clients = new Set<Client>();

  add(socket: WebSocket, userId: string, sessionId: string): Client {
    const client: Client = { socket, userId, sessionId, workspaces: new Set() };
    this.clients.add(client);
    socket.on("close", () => this.clients.delete(client));
    return client;
  }

  publish(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const c of this.clients) {
      if (c.workspaces.has(event.workspaceId) && c.socket.readyState === c.socket.OPEN) c.socket.send(data);
    }
  }

  notifyUser(userId: string, event: UserEvent): void {
    const data = JSON.stringify(event);
    for (const c of this.clients) if (c.userId === userId && c.socket.readyState === c.socket.OPEN) c.socket.send(data);
  }

  /** Stops sending a workspace's events to a user (removed member / deleted workspace). */
  revokeWorkspace(workspaceId: string, userId: string | "*", reason: "deleted" | "access_revoked"): void {
    for (const c of this.clients) {
      if (!c.workspaces.has(workspaceId) || (userId !== "*" && c.userId !== userId)) continue;
      c.workspaces.delete(workspaceId);
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify({ type: "workspace.removed", workspaceId, reason }));
    }
  }

  /** Closes sockets of revoked sessions (logout, password change, session revoke). */
  closeSessions(sessionIds: string[]): void {
    const ids = new Set(sessionIds);
    for (const c of this.clients) if (ids.has(c.sessionId)) c.socket.close(4401, "session revoked");
  }

  get size(): number {
    return this.clients.size;
  }
}
