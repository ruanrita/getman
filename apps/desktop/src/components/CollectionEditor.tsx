import { useState } from "react";
import { flattenRequests, type Collection } from "@getman/core";
import { useStore } from "../lib/store";
import { AuthEditor } from "./AuthEditor";
import { ScriptEditor } from "./ScriptEditor";
import { VariablesTable } from "./VariablesTable";

type Tab = "overview" | "variables" | "auth" | "pre" | "tests";

export function CollectionEditor({ collection }: { collection: Collection }) {
  const [tab, setTab] = useState<Tab>("overview");
  const update = (patch: Partial<Collection>) => useStore.getState().updateCollection(collection.id, (c) => ({ ...c, ...patch }));
  const requests = flattenRequests(collection.items).length;

  return (
    <div className="editor">
      <div className="editor-head">
        <input className="input bare" style={{ fontSize: 17, fontWeight: 700, width: "100%" }} value={collection.name} aria-label="Collection name" onChange={(e) => update({ name: e.target.value })} />
        <p className="muted" style={{ margin: "2px 9px 10px" }}>
          Collection · {requests} request{requests === 1 ? "" : "s"}
        </p>
      </div>
      <nav className="tabs">
        {(
          [
            ["overview", "Overview"],
            ["variables", `Variables (${collection.variables.length})`],
            ["auth", "Auth"],
            ["pre", "Pre-request"],
            ["tests", "Tests"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="pane-body">
        {tab === "overview" && (
          <div className="section">
            <h4>Description</h4>
            <textarea
              className="code"
              style={{ fontFamily: "var(--font)", minHeight: 140 }}
              placeholder="What this collection is for. Markdown is fine. The AI assistant reads this."
              value={collection.description ?? ""}
              onChange={(e) => update({ description: e.target.value })}
            />
          </div>
        )}
        {tab === "variables" && (
          <>
            <p className="hint" style={{ marginBottom: 12 }}>
              Collection variables apply to every request here. Environment variables override them.
            </p>
            <VariablesTable vars={collection.variables} onChange={(variables) => update({ variables })} />
          </>
        )}
        {tab === "auth" && (
          <>
            <p className="muted">Requests and folders set to "Inherit" use this auth.</p>
            <AuthEditor auth={collection.auth} allowInherit={false} onChange={(auth) => update({ auth })} />
          </>
        )}
        {tab === "pre" && (
          <>
            <p className="muted">Runs before every request in this collection.</p>
            <ScriptEditor kind="preRequest" value={collection.scripts.preRequest} onChange={(preRequest) => update({ scripts: { ...collection.scripts, preRequest } })} />
          </>
        )}
        {tab === "tests" && (
          <>
            <p className="muted">Runs after every request in this collection.</p>
            <ScriptEditor kind="test" value={collection.scripts.test} onChange={(test) => update({ scripts: { ...collection.scripts, test } })} />
          </>
        )}
      </div>
    </div>
  );
}
