import {
  effectiveAuth,
  findItemPath,
  prepareRequest,
  scopeChain,
  scopeFromVariables,
  scriptChain,
  type PreparedRequest,
  type RequestItem,
  type Workspace,
} from "@getman/core";
import type { ScriptVariables } from "@getman/scripts";
import { runScriptIsolated } from "./scriptRunner";
import { useStore, type RunResult } from "./store";
import { sendHttp } from "./transport";

function currentWorkspace(): Workspace {
  const s = useStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

/** Snapshot of every scope, re-read after each script so later scripts see earlier changes. */
function snapshot(collectionId: string): ScriptVariables {
  const ws = currentWorkspace();
  const env = ws.environments.find((e) => e.id === ws.activeEnvironmentId);
  const col = ws.collections.find((c) => c.id === collectionId);
  return {
    environment: Object.fromEntries(scopeFromVariables(env?.variables)),
    collection: Object.fromEntries(scopeFromVariables(col?.variables)),
    globals: Object.fromEntries(scopeFromVariables(ws.globals)),
    runtime: { ...useStore.getState().runtime },
  };
}

function prepare(collectionId: string, requestId: string): { prepared: PreparedRequest; request: RequestItem } {
  const ws = currentWorkspace();
  const col = ws.collections.find((c) => c.id === collectionId)!;
  const path = findItemPath(col, requestId)!;
  const request = path.item as RequestItem;
  const env = ws.environments.find((e) => e.id === ws.activeEnvironmentId);
  const scopes = scopeChain({
    runtime: new Map(Object.entries(useStore.getState().runtime)),
    environment: env?.variables,
    collection: col.variables,
    globals: ws.globals,
  });
  return { prepared: prepareRequest(request, effectiveAuth(request, path.ancestors), scopes), request };
}

/**
 * Full request lifecycle:
 * pre-request scripts (collection -> folders -> request) -> send -> test scripts (same order).
 */
export async function runRequest(collectionId: string, requestId: string): Promise<void> {
  const store = useStore.getState();
  store.setRunning(requestId, true);
  const result: RunResult = { tests: [], logs: [] };

  try {
    const ws = currentWorkspace();
    const col = ws.collections.find((c) => c.id === collectionId)!;
    const path = findItemPath(col, requestId)!;
    const request = path.item as RequestItem;
    const chain = scriptChain(request, path.ancestors);

    // 1. Pre-request scripts. Header/URL edits made by scripts are carried over.
    const scriptHeaders: [string, string][] = [];
    let scriptUrl: string | undefined;
    for (const { source, scripts } of chain) {
      if (!scripts.preRequest.trim()) continue;
      const before = prepare(collectionId, requestId).prepared;
      const out = await runScriptIsolated(scripts.preRequest, {
        event: "prerequest",
        requestName: request.name,
        request: { ...before, headers: [...before.headers, ...scriptHeaders], url: scriptUrl ?? before.url },
        variables: snapshot(collectionId),
      });
      result.logs.push(...out.logs.map((l) => ({ ...l, source: `${source} · pre-request` })));
      if (out.error) result.logs.push({ level: "error", message: out.error, source: `${source} · pre-request` });
      useStore.getState().applyChanges(collectionId, out.changes);
      const known = new Set(before.headers.map(([k]) => k.toLowerCase()));
      scriptHeaders.splice(0, scriptHeaders.length, ...out.request.headers.filter(([k]) => !known.has(k.toLowerCase())));
      if (out.request.url !== before.url) scriptUrl = out.request.url;
    }

    // 2. Send with variables re-resolved after the scripts ran.
    const { prepared } = prepare(collectionId, requestId);
    for (const [k, v] of scriptHeaders) {
      const i = prepared.headers.findIndex(([h]) => h.toLowerCase() === k.toLowerCase());
      if (i === -1) prepared.headers.push([k, v]);
      else prepared.headers[i] = [k, v];
    }
    if (scriptUrl) prepared.url = scriptUrl;
    result.prepared = prepared;
    result.response = await sendHttp(prepared);

    // 3. Test scripts.
    for (const { source, scripts } of chain) {
      if (!scripts.test.trim()) continue;
      const out = await runScriptIsolated(scripts.test, {
        event: "test",
        requestName: request.name,
        request: prepared,
        response: result.response,
        variables: snapshot(collectionId),
      });
      result.tests.push(...out.tests.map((t) => ({ ...t, source })));
      result.logs.push(...out.logs.map((l) => ({ ...l, source: `${source} · tests` })));
      if (out.error) result.logs.push({ level: "error", message: out.error, source: `${source} · tests` });
      useStore.getState().applyChanges(collectionId, out.changes);
    }
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    useStore.getState().setResult(requestId, result);
    useStore.getState().setRunning(requestId, false);
  }
}

/** The request as it would be sent right now (for code generation). */
export function previewRequest(collectionId: string, requestId: string): PreparedRequest {
  return prepare(collectionId, requestId).prepared;
}
