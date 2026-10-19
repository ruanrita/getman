import { keyValue } from "./factory";
import type { Auth, KeyValue, RequestItem } from "./model";
import { resolve, type Scope } from "./variables";

export type PreparedBody =
  | { kind: "text"; text: string; contentType?: string }
  | { kind: "urlencoded"; fields: [string, string][] }
  | { kind: "multipart"; fields: [string, string][] };

/** A request with every variable resolved, ready for an HTTP transport. */
export interface PreparedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: PreparedBody;
}

/**
 * Splits a raw URL into base and query params.
 * The model keeps `url` without the query string; `params` is canonical.
 */
export function splitUrl(raw: string): { base: string; params: KeyValue[] } {
  const q = raw.indexOf("?");
  if (q === -1) return { base: raw, params: [] };
  const params = raw
    .slice(q + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      return keyValue(safeDecode(key), safeDecode(value));
    });
  return { base: raw.slice(0, q), params };
}

/** Inverse of splitUrl. `{{vars}}` are kept unencoded so they still resolve. */
export function joinUrl(base: string, params: KeyValue[]): string {
  const query = params
    .filter((p) => p.enabled && p.key)
    .map((p) => `${encodeQueryPart(p.key)}=${encodeQueryPart(p.value)}`)
    .join("&");
  return query ? `${base}?${query}` : base;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function encodeQueryPart(s: string): string {
  return s
    .split(/(\{\{[^{}]*\}\})/)
    .map((part) => (part.startsWith("{{") ? part : encodeURIComponent(part)))
    .join("");
}

function enabledPairs(list: KeyValue[], scopes: Scope[]): [string, string][] {
  return list.filter((kv) => kv.enabled && kv.key).map((kv) => [resolve(kv.key, scopes), resolve(kv.value, scopes)]);
}

function hasHeader(headers: [string, string][], name: string): boolean {
  return headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
}

function base64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/**
 * Resolves variables and auth into a transport-ready request.
 * `auth` must already have `inherit` resolved (see tree.effectiveAuth).
 */
export function prepareRequest(req: RequestItem, auth: Auth, scopes: Scope[]): PreparedRequest {
  const headers = enabledPairs(req.headers, scopes);
  const params = req.params.filter((p) => p.enabled && p.key);
  let url = resolve(joinUrl(req.url, params), scopes);

  switch (auth.type) {
    case "bearer":
      if (!hasHeader(headers, "authorization")) headers.push(["Authorization", `Bearer ${resolve(auth.token, scopes)}`]);
      break;
    case "basic":
      if (!hasHeader(headers, "authorization"))
        headers.push(["Authorization", `Basic ${base64(`${resolve(auth.username, scopes)}:${resolve(auth.password, scopes)}`)}`]);
      break;
    case "apikey": {
      const key = resolve(auth.key, scopes);
      const value = resolve(auth.value, scopes);
      if (auth.in === "header") headers.push([key, value]);
      else url += `${url.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      break;
    }
  }

  let body: PreparedBody | undefined;
  const methodHasBody = !["GET", "HEAD"].includes(req.method);
  if (methodHasBody) {
    switch (req.body.mode) {
      case "json":
        body = { kind: "text", text: resolve(req.body.raw, scopes), contentType: "application/json" };
        break;
      case "raw":
        body = { kind: "text", text: resolve(req.body.raw, scopes), contentType: "text/plain" };
        break;
      case "form-urlencoded":
        body = { kind: "urlencoded", fields: enabledPairs(req.body.form, scopes) };
        break;
      case "form-data":
        body = { kind: "multipart", fields: enabledPairs(req.body.form, scopes) };
        break;
    }
  }
  if (body?.kind === "text" && body.contentType && !hasHeader(headers, "content-type")) {
    headers.push(["Content-Type", body.contentType]);
  }

  return { method: req.method, url, headers, body };
}
