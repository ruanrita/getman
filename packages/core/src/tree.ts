import type { Auth, Collection, Folder, Item, RequestItem, Scripts } from "./model";

/** Collection followed by every folder down to (excluding) the item. */
export type Ancestors = [Collection, ...Folder[]];

export function findItemPath(collection: Collection, itemId: string): { item: Item; ancestors: Ancestors } | undefined {
  const walk = (items: Item[], trail: Folder[]): { item: Item; trail: Folder[] } | undefined => {
    for (const item of items) {
      if (item.id === itemId) return { item, trail };
      if (item.kind === "folder") {
        const found = walk(item.items, [...trail, item]);
        if (found) return found;
      }
    }
    return undefined;
  };
  const found = walk(collection.items, []);
  return found && { item: found.item, ancestors: [collection, ...found.trail] };
}

export function flattenRequests(items: Item[]): RequestItem[] {
  return items.flatMap((i) => (i.kind === "request" ? [i] : flattenRequests(i.items)));
}

/** Auth after resolving `inherit` up the folder chain to the collection. */
export function effectiveAuth(item: RequestItem | Folder, ancestors: Ancestors): Auth {
  if (item.auth.type !== "inherit") return item.auth;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const auth = ancestors[i]!.auth;
    if (auth.type !== "inherit") return auth;
  }
  return { type: "none" };
}

/**
 * Scripts that run for a request, outermost first:
 * collection -> folders -> request (same order as Postman).
 */
export function scriptChain(request: RequestItem, ancestors: Ancestors): { source: string; scripts: Scripts }[] {
  return [
    ...ancestors.map((a) => ({ source: a.name, scripts: a.scripts })),
    { source: request.name, scripts: request.scripts },
  ];
}

/** Immutable update: replaces the item with `itemId` anywhere in the tree. */
export function updateItem(items: Item[], itemId: string, fn: (item: Item) => Item): Item[] {
  return items.map((i) => {
    if (i.id === itemId) return fn(i);
    if (i.kind === "folder") return { ...i, items: updateItem(i.items, itemId, fn) };
    return i;
  });
}

export function removeItem(items: Item[], itemId: string): Item[] {
  return items
    .filter((i) => i.id !== itemId)
    .map((i) => (i.kind === "folder" ? { ...i, items: removeItem(i.items, itemId) } : i));
}

/** Adds `item` to the folder `parentId`, or at the root when parentId is undefined. */
export function insertItem(items: Item[], item: Item, parentId?: string): Item[] {
  if (!parentId) return [...items, item];
  return items.map((i) => {
    if (i.kind !== "folder") return i;
    if (i.id === parentId) return { ...i, items: [...i.items, item] };
    return { ...i, items: insertItem(i.items, item, parentId) };
  });
}
