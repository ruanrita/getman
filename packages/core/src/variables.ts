import type { Variable } from "./model";

/**
 * A resolution scope. Scopes are consulted in order: the first scope that
 * defines a key wins. Use `scopeChain` to build the standard order.
 */
export type Scope = Map<string, string>;

const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 5;

/** The value a variable resolves to: device-local value first, then shared value. */
export function effectiveValue(v: Variable): string {
  return v.localValue !== undefined && v.localValue !== "" ? v.localValue : v.value;
}

export function scopeFromVariables(vars: Variable[] | undefined): Scope {
  const scope: Scope = new Map();
  for (const v of vars ?? []) {
    if (v.enabled && v.key) scope.set(v.key, effectiveValue(v));
  }
  return scope;
}

/**
 * Standard precedence, highest first (same as Postman):
 * runtime (set by scripts during a run) > environment > collection > globals.
 */
export function scopeChain(parts: {
  runtime?: Scope;
  environment?: Variable[];
  collection?: Variable[];
  globals?: Variable[];
}): Scope[] {
  return [
    parts.runtime ?? new Map(),
    scopeFromVariables(parts.environment),
    scopeFromVariables(parts.collection),
    scopeFromVariables(parts.globals),
  ];
}

export function lookup(name: string, scopes: Scope[]): string | undefined {
  for (const scope of scopes) {
    const value = scope.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

const dynamicVariables: Record<string, () => string> = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

/**
 * Replaces every `{{name}}` in `text`. Unknown variables are left untouched so
 * the user can see what is missing. Values may reference other variables
 * (resolved up to MAX_DEPTH levels to avoid cycles).
 */
export function resolve(text: string, scopes: Scope[]): string {
  let out = text;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let changed = false;
    out = out.replace(VAR_PATTERN, (match, rawName: string) => {
      const name = rawName.trim();
      const value = name.startsWith("$") ? dynamicVariables[name]?.() : lookup(name, scopes);
      if (value === undefined) return match;
      changed = true;
      return value;
    });
    if (!changed) break;
  }
  return out;
}

/** Variable names referenced in `text` that no scope defines. */
export function unresolvedVariables(text: string, scopes: Scope[]): string[] {
  const missing = new Set<string>();
  for (const m of resolve(text, scopes).matchAll(VAR_PATTERN)) {
    const name = m[1]!.trim();
    if (!name.startsWith("$")) missing.add(name);
  }
  return [...missing];
}

/**
 * Copy of `vars` that is safe to leave the device: local values are dropped
 * and secret values are blanked.
 */
export function sanitizeVariables(vars: Variable[]): Variable[] {
  return vars.map(({ localValue: _local, ...v }) => (v.secret ? { ...v, value: "" } : v));
}
