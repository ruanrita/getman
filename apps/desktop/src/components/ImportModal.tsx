import { useState } from "react";
import { flattenRequests } from "@getman/core";
import { importAny, type ImportResult } from "@getman/importers";
import { useStore } from "../lib/store";
import { toast } from "../lib/ui";
import { Modal } from "./Modal";

const FORMAT_LABEL: Record<ImportResult["format"], string> = {
  getman: "Getman",
  "postman-collection": "Postman collection",
  "postman-environment": "Postman environment",
  openapi: "OpenAPI / Swagger",
  curl: "cURL",
};

export function ImportModal({ onClose }: { onClose(): void }) {
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState<string>();

  const parse = (input: string) => {
    setText(input);
    setResult(undefined);
    setError(undefined);
    if (!input.trim()) return;
    try {
      setResult(importAny(input));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (file) parse(await file.text());
  };

  const confirmImport = () => {
    if (!result) return;
    useStore.getState().importResult(result);
    const first = result.collections[0];
    if (first) useStore.getState().select({ collectionId: first.id });
    toast(`Imported ${result.collections.length} collection(s) and ${result.environments.length} environment(s)`);
    onClose();
  };

  return (
    <Modal
      title="Import"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!result} onClick={confirmImport}>Import</button>
        </>
      }
    >
      <label
        className={`dropzone ${over ? "over" : ""}`}
        style={{ display: "block", cursor: "pointer" }}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => (e.preventDefault(), setOver(false), onFiles(e.dataTransfer.files))}
      >
        <input type="file" accept=".json,.yaml,.yml,.txt" hidden onChange={(e) => onFiles(e.target.files)} />
        <strong>Drop a file here or click to choose</strong>
        <div>Postman collection v2.0/v2.1 · Postman environment · OpenAPI 3 / Swagger 2 (JSON or YAML) · Getman</div>
      </label>

      <p className="muted" style={{ margin: "14px 0 6px" }}>…or paste the content (a cURL command works too):</p>
      <textarea className="code" spellCheck={false} placeholder="curl https://api.example.com -H 'Accept: application/json'" value={text} onChange={(e) => parse(e.target.value)} />

      {error && <p className="hint warn" style={{ marginTop: 10 }}>{error}</p>}
      {result && (
        <div className="hint" style={{ marginTop: 10 }}>
          Detected <strong>{FORMAT_LABEL[result.format]}</strong>:{" "}
          {result.collections.map((c) => `"${c.name}" (${flattenRequests(c.items).length} requests)`).join(", ")}
          {result.environments.map((e) => `environment "${e.name}" (${e.variables.length} variables)`).join(", ")}
        </div>
      )}
    </Modal>
  );
}
