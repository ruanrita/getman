import { keyValue, newRequest, splitUrl, HTTP_METHODS, type HttpMethod, type PreparedRequest, type RequestItem } from "@getman/core";

/**
 * Splits a shell command line into arguments. Handles single/double quotes,
 * backslash escapes and line continuations (`\` on bash, `^` on cmd.exe).
 */
export function tokenize(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < src.length) current += src[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === "$" && src[i + 1] === "'") {
      // Bash ANSI-C quoting: $'...'
      quote = "'";
      inToken = true;
      i++;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else if (ch === "\\" && i + 1 < src.length) {
      current += src[++i];
      inToken = true;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"]);
const IGNORED_WITH_VALUE = new Set(["-o", "--output", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie"]);

export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

export function importCurl(command: string): RequestItem {
  const args = tokenize(command.trim());
  if (!/^curl(\.exe)?$/i.test(args[0] ?? "")) throw new Error("Not a cURL command");

  const req = newRequest();
  req.auth = { type: "none" };
  let method: string | undefined;
  let rawUrl = "";
  const data: string[] = [];
  const form: [string, string][] = [];
  let forceGet = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => args[++i] ?? "";
    // Support --flag=value
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? next();

    if (flag === "-X" || flag === "--request") method = value().toUpperCase();
    else if (flag === "-H" || flag === "--header") {
      const h = value();
      const colon = h.indexOf(":");
      if (colon > 0) req.headers.push(keyValue(h.slice(0, colon).trim(), h.slice(colon + 1).trim()));
    } else if (DATA_FLAGS.has(flag)) data.push(value());
    else if (flag === "-F" || flag === "--form") {
      const f = value();
      const eq = f.indexOf("=");
      form.push([f.slice(0, eq), f.slice(eq + 1)]);
    } else if (flag === "-u" || flag === "--user") {
      const u = value();
      const colon = u.indexOf(":");
      req.auth = { type: "basic", username: colon === -1 ? u : u.slice(0, colon), password: colon === -1 ? "" : u.slice(colon + 1) };
    } else if (flag === "--url") rawUrl = value();
    else if (flag === "-G" || flag === "--get") forceGet = true;
    else if (flag === "-I" || flag === "--head") method = "HEAD";
    else if (IGNORED_WITH_VALUE.has(flag)) value();
    else if (!flag.startsWith("-")) rawUrl = flag;
    // Everything else (-k, -L, -s, -v, --compressed, ...) does not change the request.
  }

  if (forceGet && data.length) {
    rawUrl += (rawUrl.includes("?") ? "&" : "?") + data.join("&");
    data.length = 0;
  }

  const { base, params } = splitUrl(rawUrl);
  req.url = base;
  req.params = params;
  req.name = base.replace(/^https?:\/\//, "") || "cURL request";

  const contentType = req.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
  if (form.length) {
    req.body = { mode: "form-data", raw: "", form: form.map(([k, v]) => keyValue(k, v)) };
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  } else if (data.length) {
    const body = data.join("&");
    if (contentType.includes("json") || /^\s*[[{]/.test(body)) {
      req.body = { mode: "json", raw: prettyJson(body), form: [] };
    } else if (!contentType || contentType.includes("x-www-form-urlencoded")) {
      req.body = { mode: "form-urlencoded", raw: "", form: splitUrl(`?${body}`).params };
    } else {
      req.body = { mode: "raw", raw: body, form: [] };
    }
  }

  const finalMethod = (method ?? (data.length || form.length ? "POST" : "GET")) as HttpMethod;
  req.method = HTTP_METHODS.includes(finalMethod) ? finalMethod : "GET";
  return req;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Exports an already-prepared (variables resolved) request as a bash cURL command. */
export function exportCurl(req: PreparedRequest): string {
  const parts = [`curl -X ${req.method} ${shellQuote(req.url)}`];
  for (const [k, v] of req.headers) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (req.body?.kind === "text") parts.push(`--data-raw ${shellQuote(req.body.text)}`);
  if (req.body?.kind === "urlencoded")
    for (const [k, v] of req.body.fields) parts.push(`--data-urlencode ${shellQuote(`${k}=${v}`)}`);
  if (req.body?.kind === "multipart") for (const [k, v] of req.body.fields) parts.push(`-F ${shellQuote(`${k}=${v}`)}`);
  return parts.join(" \\\n  ");
}
