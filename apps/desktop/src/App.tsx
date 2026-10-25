import { useEffect, useState } from "react";
import { findItemPath } from "@getman/core";
import { AccountModal } from "./components/AccountModal";
import { AiPanel } from "./components/AiPanel";
import { CollectionEditor } from "./components/CollectionEditor";
import { GitModal } from "./components/GitModal";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { EnvironmentsModal } from "./components/EnvironmentsModal";
import { ExportModal } from "./components/ExportModal";
import { ImportModal } from "./components/ImportModal";
import { RequestEditor } from "./components/RequestEditor";
import { Sidebar } from "./components/Sidebar";
import { TopBar, type ModalName } from "./components/TopBar";
import { useActiveWorkspace, useStore } from "./lib/store";
import { startGitSync } from "./lib/gitSync";
import { startSync } from "./lib/sync";
import { useToast } from "./lib/ui";

export function App() {
  const hydrated = useStore((s) => s.hydrated);
  const theme = useStore((s) => s.theme);
  const selection = useStore((s) => s.selection);
  const ws = useActiveWorkspace();
  const toastMessage = useToast((s) => s.message);
  const aiOpen = useStore((s) => s.aiOpen);
  const [modal, setModal] = useState<ModalName | null>(null);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!hydrated) return;
    startSync();
    startGitSync();
  }, [hydrated]);

  if (!hydrated) return null;

  const collection = ws.collections.find((c) => c.id === selection?.collectionId);
  const item = collection && selection?.itemId ? findItemPath(collection, selection.itemId)?.item : undefined;

  return (
    <div className={`app ${aiOpen ? "ai-open" : ""}`}>
      <TopBar open={setModal} />
      <Sidebar />
      <main className="main">
        {collection && item?.kind === "request" && <RequestEditor key={item.id} collectionId={collection.id} request={item} />}
        {collection && !selection?.itemId && <CollectionEditor key={collection.id} collection={collection} />}
        {!collection && (
          <div className="empty">
            <h2>Welcome to Getman</h2>
            <p>Pick a request on the left, or import a Postman collection, an OpenAPI spec or a cURL command.</p>
            <button className="btn primary" onClick={() => setModal("import")}>
              Import
            </button>
          </div>
        )}
      </main>
      {aiOpen && <AiPanel />}

      {modal === "environments" && <EnvironmentsModal onClose={() => setModal(null)} />}
      {modal === "import" && <ImportModal onClose={() => setModal(null)} />}
      {modal === "export" && <ExportModal onClose={() => setModal(null)} />}
      {modal === "account" && <AccountModal onClose={() => setModal(null)} />}
      {modal === "git" && <GitModal onClose={() => setModal(null)} />}
      {modal === "workspace" && <WorkspaceModal onClose={() => setModal(null)} />}
      {modal === "newWorkspace" && <NewWorkspaceModal onClose={() => setModal(null)} onConnect={() => setModal("account")} />}
      {toastMessage && <div className="toast" role="status">{toastMessage}</div>}
    </div>
  );
}
