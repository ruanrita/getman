import type { ScriptContext, ScriptResult } from "@getman/scripts";
import ScriptWorker from "@getman/scripts/src/worker?worker";
import { sendHttp } from "./transport";

export const SCRIPT_TIMEOUT_MS = 10_000;

/**
 * Runs a script in a fresh Web Worker that is terminated afterwards, so an
 * infinite loop in user code cannot freeze the app.
 */
export function runScriptIsolated(code: string, ctx: Omit<ScriptContext, "send">): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const worker = new ScriptWorker();
    const finish = (result: ScriptResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ tests: [], logs: [], changes: [], request: ctx.request, error: `Script timed out after ${SCRIPT_TIMEOUT_MS / 1000}s` }),
      SCRIPT_TIMEOUT_MS,
    );

    worker.onmessage = async (event) => {
      const msg = event.data;
      if (msg.type === "done") finish(msg.result);
      if (msg.type === "send") {
        try {
          worker.postMessage({ type: "sendResult", id: msg.id, response: await sendHttp(msg.request) });
        } catch (e) {
          worker.postMessage({ type: "sendResult", id: msg.id, error: (e as Error).message });
        }
      }
    };
    worker.onerror = (e) => finish({ tests: [], logs: [], changes: [], request: ctx.request, error: e.message });
    worker.postMessage({ type: "run", code, ctx });
  });
}
