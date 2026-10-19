/**
 * OpenAPI 3.x and Swagger 2.0 import (one-way: spec -> collection).
 * Operations are grouped into folders by their first tag.
 */
import {
  keyValue,
  newCollection,
  newFolder,
  newRequest,
  variable,
  HTTP_METHODS,
  type Collection,
  type Folder,
  type HttpMethod,
} from "@getman/core";

type Json = Record<string, any>;

export function isOpenApi(data: unknown): data is Json {
  const d = data as Json;
  return typeof d?.paths === "object" && (typeof d.openapi === "string" || typeof d.swagger === "string");
}

/** Follows a local `#/components/...` reference. External refs are not resolved. */
function deref(spec: Json, obj: Json | undefined, seen = new Set<string>()): Json | undefined {
  if (!obj?.$ref || typeof obj.$ref !== "string") return obj;
  if (seen.has(obj.$ref) || !obj.$ref.startsWith("#/")) return {};
  seen.add(obj.$ref);
  const target = obj.$ref
    .slice(2)
    .split("/")
    .reduce<Json | undefined>((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
  return deref(spec, target, seen);
}

/** Builds a sample value from a JSON schema (examples first, then types). */
export function sampleFromSchema(spec: Json, schema: Json | undefined, depth = 0): unknown {
  const s = deref(spec, schema);
  if (!s || depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const composed = s.allOf ?? s.oneOf ?? s.anyOf;
  if (Array.isArray(composed)) {
    if (s.allOf) return Object.assign({}, ...composed.map((c: Json) => sampleFromSchema(spec, c, depth + 1)));
    return sampleFromSchema(spec, composed[0], depth + 1);
  }
  switch (s.type) {
    case "object":
    case undefined:
      if (!s.properties) return s.type === "object" ? {} : null;
      return Object.fromEntries(
        Object.entries(s.properties as Json).map(([k, v]) => [k, sampleFromSchema(spec, v as Json, depth + 1)]),
      );
    case "array":
      return [sampleFromSchema(spec, s.items, depth + 1)];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    case "string":
      return s.format === "date-time" ? new Date(0).toISOString() : s.format === "uuid" ? "00000000-0000-0000-0000-000000000000" : "string";
    default:
      return null;
  }
}

function baseUrl(spec: Json): string {
  if (spec.openapi) {
    const server = spec.servers?.[0];
    if (!server) return "";
    // Substitute server variables with their defaults.
    return String(server.url).replace(/\{(\w+)\}/g, (_: string, name: string) => server.variables?.[name]?.default ?? name);
  }
  const scheme = spec.schemes?.[0] ?? "https";
  return spec.host ? `${scheme}://${spec.host}${spec.basePath ?? ""}` : (spec.basePath ?? "");
}

export function importOpenApi(spec: Json): Collection {
  const collection = newCollection(spec.info?.title ?? "OpenAPI import");
  collection.description = spec.info?.description;
  collection.variables.push(variable("baseUrl", baseUrl(spec).replace(/\/$/, "")));

  const schemes: Json = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const scheme = Object.values(schemes)[0] as Json | undefined;
  if (scheme?.scheme === "bearer" || scheme?.type === "oauth2") {
    collection.auth = { type: "bearer", token: "{{token}}" };
    collection.variables.push(variable("token", "", { secret: true }));
  } else if (scheme?.scheme === "basic" || scheme?.type === "basic") {
    collection.auth = { type: "basic", username: "{{username}}", password: "{{password}}" };
  } else if (scheme?.type === "apiKey") {
    collection.auth = { type: "apikey", key: scheme.name, value: "{{apiKey}}", in: scheme.in === "query" ? "query" : "header" };
    collection.variables.push(variable("apiKey", "", { secret: true }));
  }

  const folders = new Map<string, Folder>();
  for (const [path, pathItem] of Object.entries((spec.paths ?? {}) as Json)) {
    const sharedParams: Json[] = pathItem.parameters ?? [];
    for (const [rawMethod, op] of Object.entries(pathItem as Json)) {
      const method = rawMethod.toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) continue;
      const operation = op as Json;

      const req = newRequest(operation.summary ?? operation.operationId ?? `${method} ${path}`, method);
      req.description = operation.description;
      req.url = `{{baseUrl}}${path.replace(/\{(\w+)\}/g, "{{$1}}")}`;

      for (const p of [...sharedParams, ...(operation.parameters ?? [])].map((p: Json) => deref(spec, p)!)) {
        const example = p.example ?? p.schema?.example ?? p.default ?? "";
        if (p.in === "query") req.params.push({ ...keyValue(p.name, String(example), Boolean(p.required)), description: p.description });
        if (p.in === "header") req.headers.push({ ...keyValue(p.name, String(example)), description: p.description });
        if (p.in === "body") req.body = { mode: "json", raw: JSON.stringify(sampleFromSchema(spec, p.schema), null, 2), form: [] };
      }

      const content: Json | undefined = deref(spec, operation.requestBody)?.content;
      if (content?.["application/json"]) {
        const media = content["application/json"];
        const sample = media.example ?? sampleFromSchema(spec, media.schema);
        req.body = { mode: "json", raw: JSON.stringify(sample, null, 2), form: [] };
      } else if (content?.["application/x-www-form-urlencoded"] || content?.["multipart/form-data"]) {
        const isMultipart = Boolean(content["multipart/form-data"]);
        const schema = deref(spec, (content["multipart/form-data"] ?? content["application/x-www-form-urlencoded"]).schema);
        req.body = {
          mode: isMultipart ? "form-data" : "form-urlencoded",
          raw: "",
          form: Object.keys(schema?.properties ?? {}).map((k) => keyValue(k, "")),
        };
      }

      const tag: string | undefined = operation.tags?.[0];
      if (tag) {
        if (!folders.has(tag)) {
          const folder = newFolder(tag);
          folders.set(tag, folder);
          collection.items.push(folder);
        }
        folders.get(tag)!.items.push(req);
      } else {
        collection.items.push(req);
      }
    }
  }
  return collection;
}
