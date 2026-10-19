/// <reference lib="webworker" />
/**
 * Web Worker entry that runs a single script in isolation.
 *
 * The worker is created per script run and terminated afterwards (or on
 * timeout), so user code cannot keep state or block the UI thread. Storage
 * APIs are removed before user code runs so scripts cannot read other
 * workspaces' data. See docs/features/scripts.md for the security model.
 */
import { runScript, type ScriptContext } from "./engine";

for (const api of ["indexedDB", "caches", "localStorage", "sessionStorage"]) {
  try {
    Object.defineProperty(self, api, { value: undefined, configurable: false });
  } catch {
    // Not present in this runtime.
  }
}

type Incoming =
  | { type: "run"; code: string; ctx: Omit<ScriptContext, "send"> }
  | { type: "sendResult"; id: number; response?: ScriptContext["response"]; error?: string };

const pending = new Map<number, { resolve: (r: NonNullable<ScriptContext["response"]>) => void; reject: (e: Error) => void }>();
let nextId = 0;

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const msg = event.data;
  if (msg.type === "sendResult") {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.response) p?.resolve(msg.response);
    else p?.reject(new Error(msg.error ?? "Request failed"));
    return;
  }
  const result = await runScript(msg.code, {
    ...msg.ctx,
    // pm.sendRequest is proxied to the main thread, which owns the HTTP transport.
    send: (request) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        self.postMessage({ type: "send", id, request });
      }),
  });
  self.postMessage({ type: "done", result });
};
