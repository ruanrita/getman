import { useState } from "react";
import { newCollection, newFolder, newRequest, type Collection, type Item } from "@getman/core";
import { useActiveWorkspace, useStore } from "../lib/store";

export function Sidebar() {
  const ws = useActiveWorkspace();
  const addCollection = useStore((s) => s.addCollection);
  const select = useStore((s) => s.select);
  const [filter, setFilter] = useState("");

  const create = () => {
    const c = newCollection();
    addCollection(c);
    select({ collectionId: c.id });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input className="input" placeholder="Filter requests" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn icon" title="New collection" aria-label="New collection" onClick={create}>
          +
        </button>
      </div>
      <div className="tree" role="tree">
        {ws.collections.map((c) => (
          <CollectionNode key={c.id} collection={c} filter={filter.toLowerCase()} />
        ))}
        {ws.collections.length === 0 && <p className="muted" style={{ padding: 10 }}>No collections yet. Create one or import a Postman/OpenAPI file.</p>}
      </div>
    </aside>
  );
}

function matches(item: Item, filter: string): boolean {
  if (!filter) return true;
  if (item.name.toLowerCase().includes(filter)) return true;
  if (item.kind === "request") return item.url.toLowerCase().includes(filter);
  return item.items.some((i) => matches(i, filter));
}

function CollectionNode({ collection, filter }: { collection: Collection; filter: string }) {
  const [open, setOpen] = useState(true);
  const selection = useStore((s) => s.selection);
  const { select, addItem, removeCollection, updateCollection } = useStore.getState();
  const selected = selection?.collectionId === collection.id && !selection.itemId;

  const addRequest = () => {
    const r = newRequest();
    addItem(collection.id, r);
    select({ collectionId: collection.id, itemId: r.id });
    setOpen(true);
  };

  return (
    <div role="treeitem" aria-expanded={open}>
      <div className={`node collection ${selected ? "selected" : ""}`} onClick={() => select({ collectionId: collection.id })}>
        <span className="caret" onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
          {open ? "▾" : "▸"}
        </span>
        <span className="label" onDoubleClick={() => rename(collection.name, (name) => updateCollection(collection.id, (c) => ({ ...c, name })))}>
          {collection.name}
        </span>
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn ghost icon" title="New request" aria-label="New request" onClick={addRequest}>
            +
          </button>
          <button className="btn ghost icon" title="New folder" aria-label="New folder" onClick={() => (addItem(collection.id, newFolder()), setOpen(true))}>
            ▤
          </button>
          <button
            className="btn ghost icon danger"
            title="Delete collection"
            aria-label="Delete collection"
            onClick={() => confirm(`Delete collection "${collection.name}"?`) && removeCollection(collection.id)}
          >
            🗑
          </button>
        </span>
      </div>
      {open &&
        collection.items
          .filter((i) => matches(i, filter))
          .map((item) => <ItemNode key={item.id} item={item} collectionId={collection.id} depth={1} filter={filter} />)}
    </div>
  );
}

function ItemNode({ item, collectionId, depth, filter }: { item: Item; collectionId: string; depth: number; filter: string }) {
  const [open, setOpen] = useState(true);
  const selected = useStore((s) => s.selection?.itemId === item.id);
  const running = useStore((s) => s.running[item.id]);
  const { select, addItem, removeItem, updateItem } = useStore.getState();
  const pad = { paddingLeft: depth * 14 };

  const renameItem = () => rename(item.name, (name) => updateItem(collectionId, item.id, (i) => ({ ...i, name })));
  const del = () => confirm(`Delete "${item.name}"?`) && removeItem(collectionId, item.id);

  if (item.kind === "request") {
    return (
      <div className={`node ${selected ? "selected" : ""}`} style={pad} role="treeitem" onClick={() => select({ collectionId, itemId: item.id })}>
        <span className={`method method-${item.method}`}>{running ? "···" : item.method === "DELETE" ? "DEL" : item.method}</span>
        <span className="label" onDoubleClick={renameItem}>
          {item.name}
        </span>
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn ghost icon danger" title="Delete" aria-label="Delete request" onClick={del}>
            🗑
          </button>
        </span>
      </div>
    );
  }

  return (
    <div role="treeitem" aria-expanded={open}>
      <div className="node" style={pad} onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="label" onDoubleClick={renameItem}>
          📁 {item.name}
        </span>
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn ghost icon"
            title="New request"
            aria-label="New request in folder"
            onClick={() => {
              const r = newRequest();
              addItem(collectionId, r, item.id);
              select({ collectionId, itemId: r.id });
              setOpen(true);
            }}
          >
            +
          </button>
          <button className="btn ghost icon" title="Rename" aria-label="Rename folder" onClick={renameItem}>
            ✎
          </button>
          <button className="btn ghost icon danger" title="Delete" aria-label="Delete folder" onClick={del}>
            🗑
          </button>
        </span>
      </div>
      {open &&
        item.items
          .filter((i) => matches(i, filter))
          .map((child) => <ItemNode key={child.id} item={child} collectionId={collectionId} depth={depth + 1} filter={filter} />)}
    </div>
  );
}

function rename(current: string, apply: (name: string) => void) {
  const name = prompt("Rename", current)?.trim();
  if (name) apply(name);
}
