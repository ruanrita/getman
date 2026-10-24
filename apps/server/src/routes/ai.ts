import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Action } from "@getman/core";
import { z } from "zod";
import { complete, DEFAULT_ANTHROPIC_MODEL, type AiProvider } from "../ai/providers";
import { requireAuth } from "../auth";
import type { Config } from "../config";
import { decrypt, encrypt } from "../crypto";
import type { Sql } from "../db";
import { badRequest } from "../errors";
import { assertReachableUrl } from "../net";

type Access = (req: FastifyRequest, workspaceId: string, action: Action) => Promise<{ id: string }>;

interface AiRow {
  ai_provider: AiProvider | null;
  ai_base_url: string | null;
  ai_model: string | null;
  ai_key_enc: string | null;
}

/**
 * Workspace-level AI: an admin stores one provider key on the server and
 * members chat through this proxy without ever seeing the key.
 * (Per-user keys never touch the server; the desktop app calls providers directly.)
 */
export function aiRoutes(app: FastifyInstance, sql: Sql, config: Config, access: Access) {
  const auth = requireAuth(sql, config);

  app.get<{ Params: { id: string } }>("/workspaces/:id/ai", { preHandler: auth }, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    const [row] = await sql<AiRow[]>`select ai_provider, ai_base_url, ai_model, ai_key_enc from workspaces where id = ${ws.id}`;
    return {
      enabled: Boolean(row?.ai_provider),
      provider: row?.ai_provider,
      baseUrl: row?.ai_base_url,
      model: row?.ai_model ?? (row?.ai_provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : null),
      hasKey: Boolean(row?.ai_key_enc),
    };
  });

  /** `apiKey`: omitted = keep the stored key, null = remove it. `provider: null` turns workspace AI off. */
  app.put<{ Params: { id: string } }>("/workspaces/:id/ai", { preHandler: auth }, async (req) => {
    const ws = await access(req, req.params.id, "ai.configure");
    const body = z
      .object({
        provider: z.enum(["anthropic", "openai-compatible"]).nullable(),
        baseUrl: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
        model: z.string().max(200).nullable().optional().or(z.literal("").transform(() => null)),
        apiKey: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);
    if (body.provider === "openai-compatible" && (!body.baseUrl || !body.model)) throw badRequest("OpenAI-compatible providers need a base URL and a model");
    if (body.baseUrl) await assertReachableUrl(body.baseUrl, config.allowPrivateNetworks);
    const keyEnc = body.apiKey === undefined ? undefined : body.apiKey === null || body.provider === null ? null : encrypt(config.encryptionKey, body.apiKey);
    await sql`
      update workspaces set ai_provider = ${body.provider}, ai_base_url = ${body.baseUrl ?? null}, ai_model = ${body.model ?? null},
        ai_key_enc = ${keyEnc === undefined ? sql`ai_key_enc` : keyEnc}
      where id = ${ws.id}`;
    await sql`insert into audit_log (workspace_id, actor_id, action, details)
      values (${ws.id}, ${req.user!.id}, 'ai.configured', ${sql.json({ provider: body.provider, model: body.model ?? null, keyChanged: body.apiKey !== undefined } as never)})`;
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/ai/chat",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, bodyLimit: 2 * 1024 * 1024 },
    async (req) => {
      const ws = await access(req, req.params.id, "workspace.read");
      const body = z
        .object({
          system: z.string().max(1_000_000),
          messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(100_000) })).min(1).max(100),
        })
        .parse(req.body);
      const [row] = await sql<AiRow[]>`select ai_provider, ai_base_url, ai_model, ai_key_enc from workspaces where id = ${ws.id}`;
      if (!row?.ai_provider) throw badRequest("This workspace has no AI configured. Use your own key, or ask an admin.", "ai_not_configured");
      if (row.ai_base_url) await assertReachableUrl(row.ai_base_url, config.allowPrivateNetworks);
      const result = await complete(
        row.ai_provider,
        { apiKey: row.ai_key_enc ? decrypt(config.encryptionKey, row.ai_key_enc) : undefined, baseUrl: row.ai_base_url ?? undefined, model: row.ai_model ?? undefined },
        body,
      );
      await sql`insert into ai_usage (workspace_id, user_id, provider, model, input_tokens, output_tokens)
        values (${ws.id}, ${req.user!.id}, ${row.ai_provider}, ${result.model}, ${result.inputTokens ?? null}, ${result.outputTokens ?? null})`;
      return result;
    },
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/ai/usage", { preHandler: auth }, async (req) => {
    const ws = await access(req, req.params.id, "ai.configure");
    const usage = await sql`
      select u.email, count(*)::int as requests, coalesce(sum(a.input_tokens), 0)::int as "inputTokens", coalesce(sum(a.output_tokens), 0)::int as "outputTokens"
      from ai_usage a left join users u on u.id = a.user_id
      where a.workspace_id = ${ws.id} and a.created_at > now() - interval '30 days'
      group by u.email order by requests desc`;
    return { usage };
  });
}
