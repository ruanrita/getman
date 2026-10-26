import { saveDraft } from "../lib/save";
import { ask } from "../lib/ui";
import { useStore } from "../lib/store";

/** "● Unsaved · Discard · Save" for the item being edited. */
export function SaveControls({ draftKeyValue, dirty }: { draftKeyValue: string; dirty: boolean }) {
  if (!dirty) return <span className="muted saved-mark" title="All changes saved">Saved</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="unsaved-mark" title="Only on this device until you save">● Unsaved</span>
      <button
        className="btn ghost"
        onClick={async () => (await ask("Discard your unsaved changes to this item?")) && useStore.getState().discardDraft(draftKeyValue)}
      >
        Discard
      </button>
      <button className="btn primary" title="Save and share (Ctrl+S)" onClick={() => saveDraft(draftKeyValue)}>
        Save
      </button>
    </span>
  );
}
