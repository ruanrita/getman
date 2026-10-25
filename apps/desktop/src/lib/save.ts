import { collectionSettingsToYaml, itemToYaml, variablesToYaml } from "@getman/importers";
import type { Collection, Environment, RequestItem, Variable } from "@getman/core";
import { askConflict } from "./dialogs";
import { draftsOf, savedValueOf, type Draft } from "./drafts";
import { useStore } from "./store";
import { toast } from "./ui";

const label = (d: Draft) => (d.kind === "globals" ? "Globals" : d.value.name);

/** A draft or its saved counterpart as YAML, for the comparison view. */
function toYaml(kind: Draft["kind"], value: unknown): string {
  if (value === undefined) return "(deleted)\n";
  switch (kind) {
    case "request":
      return itemToYaml(value as RequestItem);
    case "collection":
      return collectionSettingsToYaml(value as Omit<Collection, "items">);
    case "environment":
      return variablesToYaml((value as Environment).name, (value as Environment).variables);
    case "globals":
      return variablesToYaml(undefined, value as Variable[]);
  }
}

/** Shows both versions and applies the choice. Returns true if the draft was saved. */
async function resolveConflict(key: string): Promise<boolean> {
  const s = useStore.getState();
  const d = s.drafts[key];
  const ws = s.workspaces.find((w) => w.id === d?.wsId);
  if (!d || !ws) return false;
  const choice = await askConflict(label(d), toYaml(d.kind, d.value), toYaml(d.kind, savedValueOf(ws, d)));
  if (choice === "mine") return useStore.getState().saveDraft(key, true) === "saved";
  if (choice === "theirs") useStore.getState().discardDraft(key);
  return false;
}

/** Saves one draft; if someone else saved the item meanwhile, asks first (with a comparison). */
export async function saveDraft(key: string): Promise<boolean> {
  const { saveDraft: save, drafts } = useStore.getState();
  const d = drafts[key];
  const result = save(key);
  if (result === "conflict") return resolveConflict(key);
  if (result === "missing" && d) toast(`"${label(d)}" no longer exists, so it could not be saved. Discard the draft or copy what you need.`);
  return result === "saved";
}

/** Ctrl+Shift+S / Save all: saves every draft of the active workspace, asking about each conflict. */
export async function saveAll() {
  const s = useStore.getState();
  const count = draftsOf(s.drafts, s.activeWorkspaceId).length;
  if (!count) return;
  for (const key of s.saveAll()) await resolveConflict(key);
  const left = draftsOf(useStore.getState().drafts, s.activeWorkspaceId).length;
  toast(left ? `Saved ${count - left} of ${count} changes` : `Saved ${count} change${count === 1 ? "" : "s"}`);
}
