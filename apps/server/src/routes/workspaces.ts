import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, canChangeRole, sanitizeVariables, type Action, type Role, type Variable } from "@getman/core";
import { z } from "zod";
import { requireAuth } from "../auth";
import type { Config } from "../config";
import type { Sql } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import type { Hub } from "../realtime";

const uuid = z.string().uuid();
const role = z.enum(["admin", "editor", "viewer"]);

const variables = z.array(z.object({ key: z.string(), value: z.string() }).passthrough()).max(5000);
/** Shape check only; the full model is validated by the client that wrote it. */
const collectionBody = z.object({
  collection: z.object({ id: uuid, name: z.string().max(500), items: z.array(z.any()), variables }).passthrough(),
  baseVersion: z.number().int().min(0),
});
const environmentBody = z.object({
  environment: z.object({ id: uuid, name: z.string().max(500), variables }).passthrough(),
  baseVersion: z.number().int().min(0),
});

/** Secrets and device-local values never reach the server, even from an old or buggy client. */
const clean = (vars: unknown) => sanitizeVariables(vars as Variable[]);

interface WsRow {
  id: string;
  name: string;
  require_2fa: boolean;
  role: Role;
}

export function workspaceRoutes(app: FastifyInstance, sql: Sql, config: Config, hub: Hub) {
  const auth = { preHandler: requireAuth(sql, config) };

  /**
   * Loads the workspace for the current user and checks `action`.
   * Non-members get 404 so workspace ids cannot be probed.
   */
  async function access(req: FastifyRequest, workspaceId: string, action: Action): Promise<WsRow> {
    if (!uuid.safeParse(workspaceId).success) throw notFound("Workspace not found");
    const [ws] = await sql<WsRow[]>`
      select w.id, w.name, w.require_2fa, m.role
      from workspaces w join members m on m.workspace_id = w.id and m.user_id = ${req.user!.id}
      where w.id = ${workspaceId}`;
    if (!ws) throw notFound("Workspace not found");
    if (ws.require_2fa && !req.user!.totpEnabled) {
      throw forbidden("This workspace requires two-factor authentication. Turn it on in your account settings.", "two_factor_required");
    }
    if (!can(ws.role, action)) throw forbidden(`Your role (${ws.role}) cannot do this`);
    return ws;
  }

  async function audit(workspaceId: string, actorId: string, action: string, details: Record<string, unknown> = {}) {
    await sql`insert into audit_log (workspace_id, actor_id, action, details) values (${workspaceId}, ${actorId}, ${action}, ${sql.json(details as never)})`;
  }

  async function members(workspaceId: string) {
    return sql<{ userId: string; email: string; name: string; role: Role; totpEnabled: boolean; addedAt: Date }[]>`
      select u.id as "userId", u.email, u.name, m.role, u.totp_enabled as "totpEnabled", m.added_at as "addedAt"
      from members m join users u on u.id = m.user_id
      where m.workspace_id = ${workspaceId}
      order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, u.email`;
  }

  /* ---------- workspaces ---------- */

  app.get("/workspaces", auth, async (req) => {
    const rows = await sql`
      select w.id, w.name, w.require_2fa as "require2fa", m.role, w.updated_at as "updatedAt"
      from workspaces w join members m on m.workspace_id = w.id
      where m.user_id = ${req.user!.id} order by w.name`;
    return { workspaces: rows };
  });

  app.post("/workspaces", auth, async (req) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const ws = await sql.begin(async (tx) => {
      const [w] = await tx<{ id: string }[]>`insert into workspaces (name) values (${name}) returning id`;
      await tx`insert into members (workspace_id, user_id, role) values (${w!.id}, ${req.user!.id}, 'owner')`;
      return w!;
    });
    await audit(ws.id, req.user!.id, "workspace.created", { name });
    return { id: ws.id, name, role: "owner", require2fa: false };
  });

  /** Full snapshot: everything a client needs to work offline. */
  app.get<{ Params: { id: string } }>("/workspaces/:id", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    const [meta] = await sql<{ globals: unknown; globals_version: number }[]>`select globals, globals_version from workspaces where id = ${ws.id}`;
    const collections = await sql<{ data: unknown; version: number }[]>`select data, version from collections where workspace_id = ${ws.id} order by updated_at`;
    const environments = await sql<{ data: unknown; version: number }[]>`select data, version from environments where workspace_id = ${ws.id} order by updated_at`;
    return {
      workspace: { id: ws.id, name: ws.name, require2fa: ws.require_2fa, role: ws.role },
      members: await members(ws.id),
      globals: { variables: meta!.globals, version: meta!.globals_version },
      collections: collections.map((c) => ({ collection: c.data, version: c.version })),
      environments: environments.map((e) => ({ environment: e.data, version: e.version })),
    };
  });

  app.patch<{ Params: { id: string } }>("/workspaces/:id", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.settings");
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), require2fa: z.boolean().optional() }).parse(req.body);
    if (body.require2fa && !req.user!.totpEnabled) {
      throw badRequest("Turn on two-factor authentication for your own account before requiring it.", "two_factor_required");
    }
    await sql`
      update workspaces set name = coalesce(${body.name ?? null}, name), require_2fa = coalesce(${body.require2fa ?? null}, require_2fa),
      updated_at = now() where id = ${ws.id}`;
    await audit(ws.id, req.user!.id, "workspace.updated", body);
    hub.publish({ type: "workspace.updated", workspaceId: ws.id, by: req.user!.id });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/workspaces/:id", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.delete");
    await sql`delete from workspaces where id = ${ws.id}`;
    hub.revokeWorkspace(ws.id, "*", "deleted");
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>("/workspaces/:id/audit", auth, async (req) => {
    const ws = await access(req, req.params.id, "members.manage");
    const before = req.query.before ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
    const entries = await sql`
      select a.id::text, a.action, a.details, a.created_at as "createdAt", u.email as "actorEmail"
      from audit_log a left join users u on u.id = a.actor_id
      where a.workspace_id = ${ws.id} and a.id < ${before}
      order by a.id desc limit 100`;
    return { entries };
  });

  /* ---------- members ---------- */

  app.get<{ Params: { id: string } }>("/workspaces/:id/members", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    return { members: await members(ws.id) };
  });

  /** Adds an existing account by email. (Email invitations for new users are planned.) */
  app.post<{ Params: { id: string } }>("/workspaces/:id/members", auth, async (req) => {
    const ws = await access(req, req.params.id, "members.manage");
    const body = z.object({ email: z.string().trim().toLowerCase().email(), role }).parse(req.body);
    const [user] = await sql<{ id: string }[]>`select id from users where email = ${body.email}`;
    if (!user) throw notFound("No Getman account uses this email on this server. Ask them to sign up first.");
    const [added] = await sql`
      insert into members (workspace_id, user_id, role) values (${ws.id}, ${user.id}, ${body.role})
      on conflict do nothing returning user_id`;
    if (!added) throw conflict("This person is already a member", "already_member");
    await audit(ws.id, req.user!.id, "member.added", { email: body.email, role: body.role });
    hub.publish({ type: "members.updated", workspaceId: ws.id, by: req.user!.id });
    hub.notifyUser(user.id, { type: "workspace.added", workspaceId: ws.id });
    return { members: await members(ws.id) };
  });

  app.patch<{ Params: { id: string; userId: string } }>("/workspaces/:id/members/:userId", auth, async (req) => {
    const ws = await access(req, req.params.id, "members.manage");
    const { role: newRole } = z.object({ role }).parse(req.body);
    const list = await members(ws.id);
    const actor = list.find((m) => m.userId === req.user!.id)!;
    const target = list.find((m) => m.userId === req.params.userId);
    if (!target) throw notFound("Member not found");
    if (!canChangeRole(actor, target, newRole)) throw forbidden("You cannot change this member's role");
    await sql`update members set role = ${newRole} where workspace_id = ${ws.id} and user_id = ${target.userId}`;
    await audit(ws.id, req.user!.id, "member.role_changed", { email: target.email, from: target.role, to: newRole });
    hub.publish({ type: "members.updated", workspaceId: ws.id, by: req.user!.id });
    return { members: await members(ws.id) };
  });

  /** Removes a member. Anyone except the owner may also remove themselves (leave). */
  app.delete<{ Params: { id: string; userId: string } }>("/workspaces/:id/members/:userId", auth, async (req) => {
    const leaving = req.params.userId === req.user!.id;
    const ws = await access(req, req.params.id, leaving ? "workspace.read" : "members.manage");
    const list = await members(ws.id);
    const target = list.find((m) => m.userId === req.params.userId);
    if (!target) throw notFound("Member not found");
    if (target.role === "owner") throw forbidden("The owner cannot be removed. Transfer ownership first.");
    if (!leaving && ws.role === "admin" && target.role === "admin") throw forbidden("Admins cannot remove other admins");
    await sql`delete from members where workspace_id = ${ws.id} and user_id = ${target.userId}`;
    await audit(ws.id, req.user!.id, leaving ? "member.left" : "member.removed", { email: target.email });
    hub.revokeWorkspace(ws.id, target.userId, "access_revoked");
    hub.publish({ type: "members.updated", workspaceId: ws.id, by: req.user!.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/transfer", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.transferOwnership");
    const { userId } = z.object({ userId: uuid }).parse(req.body);
    if (userId === req.user!.id) throw badRequest("You already own this workspace");
    const [target] = await sql<{ email: string }[]>`
      select u.email from members m join users u on u.id = m.user_id where m.workspace_id = ${ws.id} and m.user_id = ${userId}`;
    if (!target) throw notFound("The new owner must already be a member");
    // Order matters: the one-owner unique index is checked per statement.
    await sql.begin(async (tx) => {
      await tx`update members set role = 'admin' where workspace_id = ${ws.id} and user_id = ${req.user!.id}`;
      await tx`update members set role = 'owner' where workspace_id = ${ws.id} and user_id = ${userId}`;
    });
    await audit(ws.id, req.user!.id, "ownership.transferred", { to: target.email });
    hub.publish({ type: "members.updated", workspaceId: ws.id, by: req.user!.id });
    return { members: await members(ws.id) };
  });

  /* ---------- content sync ---------- */

  /**
   * Optimistic concurrency: the client sends the version it last saw.
   * Mismatch -> 409 with the current server copy; the client keeps the newer one.
   * baseVersion 0 means "create".
   */
  app.put<{ Params: { id: string; cid: string } }>("/workspaces/:id/collections/:cid", { ...auth, bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const ws = await access(req, req.params.id, "collections.write");
    const { collection, baseVersion } = collectionBody.parse(req.body);
    if (collection.id !== req.params.cid) throw badRequest("Collection id does not match the URL");
    const data = { ...collection, variables: clean(collection.variables) };

    const [current] = await sql<{ data: unknown; version: number }[]>`
      select data, version from collections where workspace_id = ${ws.id} and id = ${collection.id}`;
    if ((current?.version ?? 0) !== baseVersion) {
      throw conflict("Someone else changed this collection", "version_conflict", current ? { collection: current.data, version: current.version } : null);
    }
    const [saved] = await sql<{ version: number }[]>`
      insert into collections (workspace_id, id, data, version, updated_by) values (${ws.id}, ${collection.id}, ${sql.json(data as never)}, 1, ${req.user!.id})
      on conflict (workspace_id, id) do update set data = excluded.data, version = collections.version + 1, updated_at = now(), updated_by = excluded.updated_by
        where collections.version = ${baseVersion}
      returning version`;
    if (!saved) throw conflict("Someone else changed this collection", "version_conflict");
    if (baseVersion === 0) await audit(ws.id, req.user!.id, "collection.created", { name: collection.name });
    hub.publish({ type: "collection.put", workspaceId: ws.id, collection: data, version: saved.version, by: req.user!.id });
    return { version: saved.version };
  });

  app.delete<{ Params: { id: string; cid: string } }>("/workspaces/:id/collections/:cid", auth, async (req) => {
    const ws = await access(req, req.params.id, "collections.write");
    const [row] = await sql<{ name: string }[]>`delete from collections where workspace_id = ${ws.id} and id = ${req.params.cid} returning data->>'name' as name`;
    if (!row) throw notFound("Collection not found");
    await audit(ws.id, req.user!.id, "collection.deleted", { name: row.name });
    hub.publish({ type: "collection.deleted", workspaceId: ws.id, id: req.params.cid, by: req.user!.id });
    return { ok: true };
  });

  app.put<{ Params: { id: string; eid: string } }>("/workspaces/:id/environments/:eid", auth, async (req) => {
    const ws = await access(req, req.params.id, "environments.write");
    const { environment, baseVersion } = environmentBody.parse(req.body);
    if (environment.id !== req.params.eid) throw badRequest("Environment id does not match the URL");
    const data = { ...environment, variables: clean(environment.variables) };

    const [current] = await sql<{ data: unknown; version: number }[]>`
      select data, version from environments where workspace_id = ${ws.id} and id = ${environment.id}`;
    if ((current?.version ?? 0) !== baseVersion) {
      throw conflict("Someone else changed this environment", "version_conflict", current ? { environment: current.data, version: current.version } : null);
    }
    const [saved] = await sql<{ version: number }[]>`
      insert into environments (workspace_id, id, data, version, updated_by) values (${ws.id}, ${environment.id}, ${sql.json(data as never)}, 1, ${req.user!.id})
      on conflict (workspace_id, id) do update set data = excluded.data, version = environments.version + 1, updated_at = now(), updated_by = excluded.updated_by
        where environments.version = ${baseVersion}
      returning version`;
    if (!saved) throw conflict("Someone else changed this environment", "version_conflict");
    hub.publish({ type: "environment.put", workspaceId: ws.id, environment: data, version: saved.version, by: req.user!.id });
    return { version: saved.version };
  });

  app.delete<{ Params: { id: string; eid: string } }>("/workspaces/:id/environments/:eid", auth, async (req) => {
    const ws = await access(req, req.params.id, "environments.write");
    const [row] = await sql`delete from environments where workspace_id = ${ws.id} and id = ${req.params.eid} returning id`;
    if (!row) throw notFound("Environment not found");
    hub.publish({ type: "environment.deleted", workspaceId: ws.id, id: req.params.eid, by: req.user!.id });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id/globals", auth, async (req) => {
    const ws = await access(req, req.params.id, "environments.write");
    const body = z.object({ variables, baseVersion: z.number().int().min(1) }).parse(req.body);
    const globals = clean(body.variables);
    const [saved] = await sql<{ globals_version: number }[]>`
      update workspaces set globals = ${sql.json(globals as never)}, globals_version = globals_version + 1, updated_at = now()
      where id = ${ws.id} and globals_version = ${body.baseVersion} returning globals_version`;
    if (!saved) {
      const [cur] = await sql<{ globals: unknown; globals_version: number }[]>`select globals, globals_version from workspaces where id = ${ws.id}`;
      throw conflict("Someone else changed the globals", "version_conflict", { variables: cur!.globals, version: cur!.globals_version });
    }
    hub.publish({ type: "globals.put", workspaceId: ws.id, globals, version: saved.globals_version, by: req.user!.id });
    return { version: saved.globals_version };
  });

  /** Lets the realtime endpoint check membership with the same rules. */
  return { access };
}
