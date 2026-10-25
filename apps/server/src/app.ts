import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { userFromToken } from "./auth";
import type { Config } from "./config";
import type { Sql } from "./db";
import { HttpError } from "./errors";
import { Hub } from "./realtime";
import { aiRoutes } from "./routes/ai";
import { authRoutes } from "./routes/auth";
import { emailRoutes } from "./routes/email";
import { emailService } from "./emailService";
import { createMailer, type Mailer } from "./mail";
import { backupRoutes } from "./routes/backups";
import { workspaceRoutes } from "./routes/workspaces";

export const API_VERSION = 1;

export async function buildApp(sql: Sql, config: Config, opts: { logger?: boolean; mailer?: Mailer | null } = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  const hub = new Hub();
  // `mailer: null` forces email off (tests); undefined builds one from SMTP_URL.
  const mail = emailService(sql, opts.mailer === null ? undefined : (opts.mailer ?? createMailer(config)), hub);

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: false,
    // The plugin only allows simple methods by default; the API uses all of these.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  // Only routes that opt in (auth endpoints) are rate limited.
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.status(400).send({
        error: { code: "validation", message: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request" },
      });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many attempts. Wait a minute and try again." } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: "internal", message: "Unexpected server error" } });
  });

  /** Lets the desktop app check it is talking to a Getman server before signing in. */
  app.get("/health", async () => ({ ok: true, name: "getman-server", apiVersion: API_VERSION, features: { email: mail.enabled } }));

  authRoutes(app, sql, config, hub, mail);
  emailRoutes(app, sql, config, hub, mail);
  const { access } = workspaceRoutes(app, sql, config, hub, mail);
  backupRoutes(app, sql, config, access);
  aiRoutes(app, sql, config, access);

  /**
   * Realtime: the client authenticates with its first message instead of a
   * query string, so tokens never show up in proxy/access logs.
   *   -> { type: "auth", token }            <- { type: "ready" }
   *   -> { type: "subscribe", workspaceId } <- { type: "subscribed", workspaceId } | { type: "error", ... }
   *   <- ServerEvent (see realtime.ts)
   */
  app.get("/ws", { websocket: true }, (socket, req) => {
    let client: ReturnType<Hub["add"]> | undefined;
    const authTimeout = setTimeout(() => !client && socket.close(4401, "auth timeout"), 10_000);

    socket.on("message", async (raw) => {
      let msg: { type?: string; token?: string; workspaceId?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return socket.close(4400, "invalid message");
      }
      if (!client) {
        const user = msg.type === "auth" && msg.token ? await userFromToken(sql, config, msg.token) : undefined;
        if (!user) return socket.close(4401, "unauthorized");
        clearTimeout(authTimeout);
        client = hub.add(socket, user.id, user.sessionId);
        req.user = user;
        return socket.send(JSON.stringify({ type: "ready" }));
      }
      if (msg.type === "subscribe" && msg.workspaceId) {
        try {
          await access(req, msg.workspaceId, "workspace.read");
          client.workspaces.add(msg.workspaceId);
          socket.send(JSON.stringify({ type: "subscribed", workspaceId: msg.workspaceId }));
        } catch (e) {
          socket.send(JSON.stringify({ type: "error", workspaceId: msg.workspaceId, code: (e as HttpError).code ?? "error" }));
        }
      }
      if (msg.type === "unsubscribe" && msg.workspaceId) client.workspaces.delete(msg.workspaceId);
    });
    socket.on("close", () => clearTimeout(authTimeout));
  });

  return { app, hub };
}
