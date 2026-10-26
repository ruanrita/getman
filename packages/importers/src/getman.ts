/**
 * Native Getman format. A versioned envelope around the core model, written
 * as YAML by default so it diffs well in Git (see docs/architecture/storage.md).
 */
import YAML from "yaml";
import { sanitizeVariables, type Collection, type Environment, type Variable } from "@getman/core";

export const GETMAN_FORMAT_VERSION = 1;

export interface GetmanFile {
  getman: number;
  /** Present in whole-workspace files (backups); optional, so v1 readers ignore it. */
  workspace?: { name: string };
  globals?: Variable[];
  collections?: Collection[];
  environments?: Environment[];
}

export function isGetmanFile(data: unknown): data is GetmanFile {
  return typeof (data as GetmanFile)?.getman === "number";
}

export function exportGetman(
  content: { workspaceName?: string; globals?: Variable[]; collections?: Collection[]; environments?: Environment[] },
  format: "yaml" | "json" = "yaml",
): string {
  const file: GetmanFile = {
    getman: GETMAN_FORMAT_VERSION,
    ...(content.workspaceName !== undefined ? { workspace: { name: content.workspaceName } } : {}),
    ...(content.globals?.length ? { globals: sanitizeVariables(content.globals) } : {}),
    collections: content.collections?.map((c) => ({ ...c, variables: sanitizeVariables(c.variables) })),
    environments: content.environments?.map((e) => ({ ...e, variables: sanitizeVariables(e.variables) })),
  };
  return format === "json" ? JSON.stringify(file, null, 2) : YAML.stringify(file);
}

export function importGetman(file: GetmanFile): { collections: Collection[]; environments: Environment[]; globals: Variable[]; workspaceName?: string } {
  if (file.getman > GETMAN_FORMAT_VERSION) {
    throw new Error(`This file uses Getman format v${file.getman}; this version supports up to v${GETMAN_FORMAT_VERSION}. Update Getman.`);
  }
  return { collections: file.collections ?? [], environments: file.environments ?? [], globals: file.globals ?? [], workspaceName: file.workspace?.name };
}
