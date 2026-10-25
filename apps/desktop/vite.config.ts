import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev-only HTTP proxy so the UI can run in a normal browser (`pnpm dev`)
 * without CORS getting in the way. Inside Tauri the native HTTP plugin is used
 * instead and this endpoint is never called (see src/lib/transport.ts).
 *
 * Protection against other local pages abusing the proxy: the custom
 * `X-Getman-Proxy` header forces a CORS preflight, and the Origin must be the
 * dev server itself.
 */
function devProxy(): Plugin {
  return {
    name: "getman-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/__getman/proxy", async (req, res) => {
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (req.method !== "POST" || req.headers["x-getman-proxy"] !== "1" || (origin && new URL(origin).host !== host)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const { method, url, headers, body } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

        let payload: BodyInit | undefined;
        if (body?.kind === "text") payload = body.text;
        if (body?.kind === "urlencoded") payload = new URLSearchParams(body.fields);
        if (body?.kind === "multipart") {
          const form = new FormData();
          for (const [k, v] of body.fields) form.append(k, v);
          payload = form;
        }

        const started = performance.now();
        try {
          const upstream = await fetch(url, { method, headers, body: payload, redirect: "follow" });
          const buf = new Uint8Array(await upstream.arrayBuffer());
          const result = {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: [...upstream.headers.entries()],
            body: new TextDecoder().decode(buf),
            timeMs: Math.round(performance.now() - started),
            sizeBytes: buf.byteLength,
          };
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        } catch (e) {
          const cause = (e as { cause?: { message?: string } }).cause?.message;
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: cause ? `${(e as Error).message}: ${cause}` : String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProxy()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2022" },
  worker: { format: "es" },
  // These are imported dynamically, so Vite would only discover them at runtime and
  // re-optimise mid-session, which can load two copies of React ("Invalid hook call").
  optimizeDeps: {
    include: ["@tauri-apps/api/core", "@tauri-apps/plugin-http", "@tauri-apps/plugin-dialog", "@anthropic-ai/sdk", "qrcode"],
  },
});
