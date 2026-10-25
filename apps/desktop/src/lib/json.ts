/** JSON with sorted keys, so equal objects compare equal however they were built (or round-tripped through JSONB). */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}
