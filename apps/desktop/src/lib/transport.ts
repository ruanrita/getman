import type { HttpResponse, PreparedRequest } from "@getman/core";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

function toBody(req: PreparedRequest): BodyInit | undefined {
  const body = req.body;
  if (!body) return undefined;
  if (body.kind === "text") return body.text;
  if (body.kind === "urlencoded") return new URLSearchParams(body.fields);
  const form = new FormData();
  for (const [k, v] of body.fields) form.append(k, v);
  return form;
}

/** Native HTTP through the Tauri plugin: no CORS, full control of headers. */
async function sendViaTauri(req: PreparedRequest): Promise<HttpResponse> {
  const { fetch } = await import("@tauri-apps/plugin-http");
  const started = performance.now();
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: toBody(req) });
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    body: new TextDecoder().decode(buf),
    timeMs: Math.round(performance.now() - started),
    sizeBytes: buf.byteLength,
  };
}

/** Browser dev mode: goes through the Vite dev proxy (vite.config.ts). */
async function sendViaDevProxy(req: PreparedRequest): Promise<HttpResponse> {
  const res = await fetch("/__getman/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Getman-Proxy": "1" },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Proxy error ${res.status}`);
  return data as HttpResponse;
}

export function sendHttp(req: PreparedRequest): Promise<HttpResponse> {
  if (!/^https?:\/\//i.test(req.url)) {
    return Promise.reject(new Error(`Invalid URL "${req.url}". It must start with http:// or https:// (check for unresolved {{variables}}).`));
  }
  return isTauri() ? sendViaTauri(req) : sendViaDevProxy(req);
}
