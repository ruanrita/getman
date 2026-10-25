import { draftsOf, type Draft } from "./drafts";
import { useStore } from "./store";
import { toast } from "./ui";

const label = (d: Draft) => (d.kind === "globals" ? "Globals" : d.value.name);

/** Saves one draft; asks before replacing a version someone else saved meanwhile. */
export function saveDraft(key: string): boolean {
  const { saveDraft: save, drafts } = useStore.getState();
  const d = drafts[key];
  const result = save(key);
  if (result === "conflict" && d) {
    const replace = confirm(
      `"${label(d)}" was changed by someone else after you started editing.\n\nOK: save your version (replaces theirs).\nCancel: keep your draft unsaved.`,
    );
    return replace && save(key, true) === "saved";
  }
  if (result === "missing" && d) toast(`"${label(d)}" no longer exists, so it could not be saved. Discard the draft or copy what you need.`);
  return result === "saved";
}

/** Ctrl+Shift+S / Save all: saves every draft of the active workspace, asking once about conflicts. */
export function saveAll() {
  const s = useStore.getState();
  const count = draftsOf(s.drafts, s.activeWorkspaceId).length;
  if (!count) return;
  const conflicts = s.saveAll();
  if (conflicts.length) {
    const names = conflicts.map((k) => label(useStore.getState().drafts[k]!)).join(", ");
    if (confirm(`Someone else changed ${names} after you started editing.\n\nOK: save your versions (replace theirs).\nCancel: keep those drafts unsaved.`)) {
      for (const k of conflicts) useStore.getState().saveDraft(k, true);
    }
  }
  const left = draftsOf(useStore.getState().drafts, s.activeWorkspaceId).length;
  toast(left ? `Saved ${count - left} of ${count} changes` : `Saved ${count} change${count === 1 ? "" : "s"}`);
}
