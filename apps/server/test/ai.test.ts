import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reset, setup, signUp } from "./helpers";

/** Stands in for Anthropic / OpenAI-compatible APIs and records what it received. */
let fake: Server;
let fakeUrl: string;
const received: { path: string; headers: IncomingMessage["headers"]; body: any }[] = [];

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      received.push({ path: req.url!, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url!.startsWith("/v1/messages")) {
        res.end(
          JSON.stringify({
            id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
            content: [{ type: "text", text: "Use pm.environment.set in a test script." }],
            usage: { input_tokens: 1200, output_tokens: 15, cache_read_input_tokens: 1000 },
          }),
        );
      } else if (req.url === "/v1/chat/completions") {
        if (req.headers.authorization !== "Bearer sk-workspace") {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: { message: "bad key" } }));
        }
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "Hello from the compatible API" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 6 } }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(async () => {
  fake.close();
  await ctx.app.close();
  await ctx.sql.end();
});
beforeEach(async () => {
  received.length = 0;
  await reset(ctx.sql);
});

async function team() {
  const owner = await signUp(ctx.app, "owner@example.com");
  const viewer = await signUp(ctx.app, "viewer@example.com");
  const ws = (await owner.post("/workspaces", { name: "W" })).body;
  await owner.post(`/workspaces/${ws.id}/members`, { email: "viewer@example.com", role: "viewer" });
  return { owner, viewer, wsId: ws.id as string };
}

const chat = { system: "You are Getman's help assistant.\n\n<docs>…</docs>", messages: [{ role: "user", content: "How do I chain requests?" }] };

describe("workspace AI", () => {
  it("is off by default and only admins configure it", async () => {
    const { owner, viewer, wsId } = await team();
    expect((await viewer.get(`/workspaces/${wsId}/ai`)).body).toMatchObject({ enabled: false, hasKey: false });
    expect((await viewer.post(`/workspaces/${wsId}/ai/chat`, chat)).body.error.code).toBe("ai_not_configured");
    expect((await viewer.put(`/workspaces/${wsId}/ai`, { provider: "anthropic", apiKey: "sk-ant-x" })).status).toBe(403);
    expect((await owner.put(`/workspaces/${wsId}/ai`, { provider: "anthropic", apiKey: "sk-ant-x" })).status).toBe(200);
  });

  it("proxies Anthropic with caching and low effort, without exposing the key", async () => {
    const { owner, viewer, wsId } = await team();
    await owner.put(`/workspaces/${wsId}/ai`, { provider: "anthropic", baseUrl: fakeUrl, apiKey: "sk-ant-secret" });
    const cfg = (await viewer.get(`/workspaces/${wsId}/ai`)).body;
    expect(cfg).toMatchObject({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", hasKey: true });
    expect(JSON.stringify(cfg)).not.toContain("sk-ant-secret");

    const res = await viewer.post(`/workspaces/${wsId}/ai/chat`, chat);
    expect(res.body).toMatchObject({ text: "Use pm.environment.set in a test script.", stopReason: "end_turn", model: "claude-opus-5-5" });

    const sent = received.find((r) => r.path.startsWith("/v1/messages"))!;
    expect(sent.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(sent.body.model).toBe("claude-opus-5-5");
    expect(sent.body.output_config).toEqual({ effort: "low" });
    expect(sent.body.system).toEqual([{ type: "text", text: chat.system, cache_control: { type: "ephemeral" } }]);
    expect(sent.body.messages).toEqual(chat.messages);
    // Fallbacks are a Claude API feature; not sent to custom base URLs.
    expect(sent.body.fallbacks).toBeUndefined();

    const [usage] = await ctx.sql`select provider, model, input_tokens, output_tokens from ai_usage`;
    expect(usage).toMatchObject({ provider: "anthropic", input_tokens: 1200, output_tokens: 15 });
    expect((await owner.get(`/workspaces/${wsId}/ai/usage`)).body.usage[0]).toMatchObject({ email: "viewer@example.com", requests: 1 });
  });

  it("proxies OpenAI-compatible providers and keeps the stored key when not resent", async () => {
    const { owner, viewer, wsId } = await team();
    await owner.put(`/workspaces/${wsId}/ai`, { provider: "openai-compatible", baseUrl: `${fakeUrl}/v1`, model: "llama3", apiKey: "sk-workspace" });
    await owner.put(`/workspaces/${wsId}/ai`, { provider: "openai-compatible", baseUrl: `${fakeUrl}/v1`, model: "llama3.1" }); // key omitted -> kept
    const res = await viewer.post(`/workspaces/${wsId}/ai/chat`, chat);
    expect(res.body).toMatchObject({ text: "Hello from the compatible API", model: "llama3.1" });
    const sent = received.find((r) => r.path === "/v1/chat/completions")!;
    expect(sent.body.messages[0]).toEqual({ role: "system", content: chat.system });

    await owner.put(`/workspaces/${wsId}/ai`, { provider: "openai-compatible", baseUrl: `${fakeUrl}/v1`, model: "llama3.1", apiKey: "wrong" });
    expect((await viewer.post(`/workspaces/${wsId}/ai/chat`, chat)).body.error.code).toBe("ai_provider_error");
  });

  it("validates chat input", async () => {
    const { owner, wsId } = await team();
    await owner.put(`/workspaces/${wsId}/ai`, { provider: "anthropic", baseUrl: fakeUrl, apiKey: "k" });
    expect((await owner.post(`/workspaces/${wsId}/ai/chat`, { system: "s", messages: [] })).body.error.code).toBe("validation");
    expect((await owner.post(`/workspaces/${wsId}/ai/chat`, { system: "s", messages: [{ role: "system", content: "x" }] })).body.error.code).toBe("validation");
  });
});
