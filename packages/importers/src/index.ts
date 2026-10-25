import YAML from "yaml";
import { newCollection, type Collection, type Environment } from "@getman/core";
import { importCurl, looksLikeCurl } from "./curl";
import { importGetman, isGetmanFile } from "./getman";
import { importOpenApi, isOpenApi } from "./openapi";
import { importPostmanCollection, importPostmanEnvironment, isPostmanCollection, isPostmanEnvironment } from "./postman";

export * from "./curl";
export * from "./folder";
export * from "./getman";
export * from "./openapi";
export * from "./postman";

export type ImportFormat = "getman" | "postman-collection" | "postman-environment" | "openapi" | "curl";

export interface ImportResult {
  format: ImportFormat;
  collections: Collection[];
  environments: Environment[];
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return YAML.parse(text);
  }
}

/** Detects the format of `text` and imports it. Throws with a readable message when unsupported. */
export function importAny(text: string): ImportResult {
  if (looksLikeCurl(text)) {
    const collection = newCollection("cURL import");
    collection.items.push(importCurl(text));
    return { format: "curl", collections: [collection], environments: [] };
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch {
    throw new Error("Could not parse the file as JSON or YAML.");
  }

  if (isGetmanFile(data)) return { format: "getman", ...importGetman(data) };
  if (isPostmanCollection(data)) return { format: "postman-collection", collections: [importPostmanCollection(data)], environments: [] };
  if (isPostmanEnvironment(data)) return { format: "postman-environment", collections: [], environments: [importPostmanEnvironment(data)] };
  if (isOpenApi(data)) return { format: "openapi", collections: [importOpenApi(data)], environments: [] };

  throw new Error(
    "Unsupported format. Supported: Getman (.yaml/.json), Postman Collection v2.0/v2.1, Postman Environment, OpenAPI 3 / Swagger 2, cURL.",
  );
}
