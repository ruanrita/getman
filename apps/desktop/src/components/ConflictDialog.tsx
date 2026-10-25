import { useConflict } from "../lib/dialogs";
import { DiffView } from "./DiffView";
import { Modal } from "./Modal";

/** "Someone else saved this" - compare and choose. Rendered once in App. */
export function ConflictDialog() {
  const pending = useConflict((s) => s.pending);
  if (!pending) return null;
  return (
    <Modal
      title={`Changed by someone else: ${pending.title}`}
      onClose={() => pending.resolve("cancel")}
      footer={
        <>
          <button className="btn" onClick={() => pending.resolve("cancel")}>
            Decide later (keep my draft)
          </button>
          <button className="btn danger" onClick={() => pending.resolve("theirs")}>
            Use theirs (discard mine)
          </button>
          <button className="btn primary" onClick={() => pending.resolve("mine")}>
            Save mine (replace theirs)
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        A teammate saved this after you started editing. Compare the two versions before deciding. Previous versions stay in the history either way.
      </p>
      <DiffView before={pending.theirs} after={pending.mine} beforeLabel="Saved by your teammate" afterLabel="Your unsaved version" />
    </Modal>
  );
}
