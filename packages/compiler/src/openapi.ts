// SPDX-License-Identifier: Apache-2.0
// OpenAPI 3.0 / 3.1 → pending capabilities (AGENTS.md H5: accept 3.0, think in 3.1).
// Local `$ref`s are inlined so every tool schema is self-contained; 3.0 schema dialect is
// up-converted to JSON Schema 2020-12 on the way (nullable, boolean exclusive bounds,
// example). Vendor extensions and OpenAPI-only keywords are dropped. Each operation then
// goes through the same builder as HAR inference.

import { type Capability, SecretPlacement, sha256Text } from "@kapabl/graph";
import { parse as parseYaml } from "yaml";
import type { CompileResult } from "./har.ts";
import {
  dedupeIds,
  type Method,
  type Operation,
  type Param,
  type Skipped,
  snake,
  toCapability,
} from "./operation.ts";
import { isCredentialName } from "./scrub.ts";

export interface OpenApiImportOptions {
  /** Where calls go. Default: the origin of `servers[0]`, which must then be absolute. */
  apiOrigin?: string;
}

export interface OpenApiImportResult extends CompileResult {
  /** sha256 of the document text, recorded in every capability's provenance. */
  document: string;
  version: "3.0" | "3.1";
}

type Json = Record<string, unknown>;
/** A JSON Schema: an object, or `true`/`false`. */
type Schema = Json | boolean;

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const BODY_METHODS = new Set<Method>(["POST", "PUT", "PATCH"]);
/** OpenAPI keywords that are not JSON Schema, plus 3.0-only ones handled separately. */
const DROP = new Set(["discriminator", "xml", "externalDocs", "example", "nullable"]);
const MAX_DEPTH = 32;
/** Schema nodes one operation may inline: shared refs can otherwise grow exponentially. */
const MAX_NODES = 20_000;

/** Keywords whose value is one subschema. */
const SUBSCHEMA = new Set([
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "contentSchema",
]);
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
/** Keywords that only describe; next to a `$ref` they can be merged into it. */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapValues(map: Json, fn: (value: unknown) => unknown): Json {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fn(v)]));
}

/** An object schema for places that need one: `true` allows anything, `false` nothing. */
function objectSchema(schema: Schema): Json {
  return typeof schema === "boolean" ? (schema ? {} : { not: {} }) : schema;
}

class Resolver {
  private readonly root: Json;
  private readonly v30: boolean;
  private nodes = 0;

  constructor(root: Json, v30: boolean) {
    this.root = root;
    this.v30 = v30;
  }

  /** Start a new operation's node budget. */
  reset(): void {
    this.nodes = 0;
  }

  /** Follow a local JSON Pointer. Remote references are never fetched. */
  pointer(ref: string): unknown {
    if (!ref.startsWith("#")) throw new Error(`remote $ref "${ref}" is not supported`);
    let node: unknown = this.root;
    for (const raw of ref.slice(1).split("/").filter(Boolean)) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      node = isObject(node) || Array.isArray(node) ? (node as Json)[key] : undefined;
    }
    if (node === undefined) throw new Error(`$ref "${ref}" does not resolve`);
    return node;
  }

  /** A non-schema object (parameter, request body, response) that may itself be a $ref. */
  deref<T>(value: unknown, seen: string[] = []): T {
    if (isObject(value) && typeof value.$ref === "string") {
      if (seen.includes(value.$ref)) throw new Error(`$ref cycle at "${value.$ref}"`);
      return this.deref(this.pointer(value.$ref), [...seen, value.$ref]);
    }
    return value as T;
  }

  /**
   * Inline refs and convert to 2020-12, through every keyword that holds a subschema. A
   * recursive schema is cut off to `{}` where it repeats; one too large to inline throws.
   */
  schema(value: unknown, seen: string[] = [], depth = 0): Schema {
    if (typeof value === "boolean") return value;
    if (!isObject(value) || depth > MAX_DEPTH) return {};
    if (++this.nodes > MAX_NODES) {
      throw new Error(`its schemas are too large to inline (over ${MAX_NODES} nodes)`);
    }
    const sub = (s: unknown) => this.schema(s, seen, depth + 1);
    if (typeof value.$ref === "string") {
      if (seen.includes(value.$ref)) return {};
      // 3.0's `{ $ref, nullable: true }`: the target, or null.
      if (this.v30 && value.nullable === true) {
        const { nullable: _, ...rest } = value;
        return { anyOf: [this.schema(rest, seen, depth), { type: "null" }] };
      }
      const { $ref, ...siblings } = value;
      const target = this.schema(this.pointer($ref), [...seen, $ref], depth + 1);
      const rest = objectSchema(sub(siblings));
      const annotations = Object.fromEntries(
        Object.entries(rest).filter(([k]) => ANNOTATIONS.has(k)),
      );
      const constraints = Object.fromEntries(
        Object.entries(rest).filter(([k]) => !ANNOTATIONS.has(k)),
      );
      // 3.1 applies keywords next to $ref as well as the target: annotations can be merged
      // (they win), constraints must hold together with the target's.
      if (Object.keys(constraints).length === 0) return { ...objectSchema(target), ...annotations };
      return { ...annotations, allOf: [target, constraints] };
    }
    const out: Json = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("x-") || DROP.has(key)) continue;
      if (SUBSCHEMA_MAP.has(key) || key === "definitions") {
        if (isObject(child)) out[key === "definitions" ? "$defs" : key] = mapValues(child, sub);
      } else if (key === "dependencies" && isObject(child)) {
        // Draft 7's `dependencies` splits into 2020-12's dependentRequired and dependentSchemas.
        for (const [name, dep] of Object.entries(child)) {
          const target = Array.isArray(dep) ? "dependentRequired" : "dependentSchemas";
          out[target] = {
            ...(out[target] as Json | undefined),
            [name]: Array.isArray(dep) ? dep : sub(dep),
          };
        }
      } else if (key === "items" && Array.isArray(child)) {
        // A tuple: 2020-12 calls it prefixItems, and additionalItems becomes items.
        out.prefixItems = child.map(sub);
        if (value.additionalItems !== undefined) out.items = sub(value.additionalItems);
      } else if (key === "additionalItems") {
        // Only meaningful after a tuple `items`, handled above.
      } else if (SUBSCHEMA_LIST.has(key) && Array.isArray(child)) {
        out[key] = child.map(sub);
      } else if (SUBSCHEMA.has(key) && (isObject(child) || typeof child === "boolean")) {
        out[key] = sub(child);
      } else {
        out[key] = child;
      }
    }
    if (value.example !== undefined && out.examples === undefined) out.examples = [value.example];
    if (this.v30) {
      if (value.nullable === true) {
        // An enum must list null too, or it still refuses it.
        if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
        if (typeof out.type === "string") out.type = [out.type, "null"];
        else if (out.type === undefined) return { anyOf: [out, { type: "null" }] };
      }
      for (const [flag, bound] of [
        ["exclusiveMinimum", "minimum"],
        ["exclusiveMaximum", "maximum"],
      ] as const) {
        if (value[flag] === true && typeof value[bound] === "number") {
          out[flag] = value[bound];
          delete out[bound];
        } else if (typeof value[flag] === "boolean") {
          delete out[flag];
        }
      }
    }
    return out;
  }
}

/**
 * Drop properties marked `flag`, and their `required` entries, at every depth: readOnly
 * ones are assigned by the server and never sent; writeOnly ones are never returned.
 */
function without(schema: Schema, flag: "readOnly" | "writeOnly"): Schema {
  if (typeof schema === "boolean") return schema;
  const out: Json = { ...schema };
  const sub = (s: unknown) => (isObject(s) || typeof s === "boolean" ? without(s, flag) : s);
  if (isObject(schema.properties)) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([, s]) => !(isObject(s) && s[flag] === true))
        .map(([name, s]) => [name, sub(s)]),
    );
    out.properties = properties;
    if (Array.isArray(schema.required)) {
      const required = (schema.required as string[]).filter((name) => name in properties);
      if (required.length > 0) out.required = required;
      else delete out.required;
    }
  }
  for (const key of SUBSCHEMA) if (key in schema) out[key] = sub(schema[key]);
  for (const key of SUBSCHEMA_LIST) {
    if (Array.isArray(schema[key])) out[key] = (schema[key] as unknown[]).map(sub);
  }
  if (isObject(schema.patternProperties))
    out.patternProperties = mapValues(schema.patternProperties, sub);
  return out;
}

/** Keywords an `allOf` member may have and still be merged into one object schema. */
const MERGEABLE = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  ...ANNOTATIONS,
]);

/**
 * `allOf: [Base, { properties }]`, the usual way to extend a schema, as one object schema,
 * so its properties can become tool inputs. Left alone unless every member is a plain
 * object schema.
 */
function mergeAllOf(schema: Schema): Schema {
  if (typeof schema === "boolean" || !Array.isArray(schema.allOf)) return schema;
  const members = (schema.allOf as Schema[]).map(mergeAllOf);
  const plain = members.every(
    (m) =>
      isObject(m) &&
      (m.type === undefined || m.type === "object") &&
      Object.keys(m).every((k) => MERGEABLE.has(k)),
  );
  const { allOf: _, ...rest } = schema;
  if (!plain || !Object.keys(rest).every((k) => MERGEABLE.has(k))) return schema;
  const properties: Json = {};
  const required = new Set<string>();
  for (const member of [rest, ...(members as Json[])]) {
    for (const [name, s] of Object.entries((member.properties as Json | undefined) ?? {})) {
      properties[name] = name in properties ? { allOf: [properties[name], s] } : s;
    }
    for (const name of (member.required as string[] | undefined) ?? []) required.add(name);
  }
  // A member's additionalProperties: false would forbid the other members' properties.
  const { additionalProperties: _a, properties: _p, required: _r, type: _t, ...annotations } = rest;
  return {
    ...annotations,
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  };
}

/**
 * The `application/json` entry of a content map. The executor always sends that type, so
 * a body that only takes another JSON type (`merge-patch+json`) cannot be sent; responses
 * may be any JSON type.
 */
function jsonContent(content: unknown, exact = false): Json | undefined {
  if (!isObject(content)) return undefined;
  const types = Object.keys(content);
  const key =
    types.find((type) => /^application\/json\b/i.test(type)) ??
    (exact ? undefined : types.find((type) => /^application\/[\w.+-]+\+json\b/i.test(type)));
  return key ? (content[key] as Json) : undefined;
}

function parseDocument(input: string | object): { doc: Json; text: string } {
  if (typeof input !== "string") return { doc: input as Json, text: JSON.stringify(input) };
  const doc = parseYaml(input, { maxAliasCount: 100 }) as unknown;
  if (!isObject(doc)) throw new Error("not an OpenAPI document");
  return { doc, text: input };
}

/** The first of a `servers` list, with `{variables}` set to their defaults. */
function server(servers: unknown): URL | undefined {
  const first = Array.isArray(servers) ? (servers[0] as Json | undefined) : undefined;
  if (!first || typeof first.url !== "string") return undefined;
  const vars = isObject(first.variables) ? first.variables : {};
  const url = first.url.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = vars[name];
    return isObject(v) && typeof v.default === "string" ? v.default : "";
  });
  // `api.example.com/v1` has no scheme: it would read as a path and prefix every route.
  if (!/^(?:https?:\/\/|\/)/i.test(url)) return undefined;
  try {
    return new URL(url, "relative:/");
  } catch {
    return undefined;
  }
}

/** Where an apiKey or http scheme puts the tenant's secret, or why we cannot put it there. */
function placementOf(scheme: Json): SecretPlacement | string {
  if (scheme.type === "http") {
    const kind = String(scheme.scheme ?? "").toLowerCase();
    if (kind === "bearer" || kind === "basic") return { in: "authorization", scheme: kind };
    return `HTTP "${String(scheme.scheme)}" authentication is not supported`;
  }
  if (scheme.type === "apiKey") {
    if (scheme.in !== "header" && scheme.in !== "query") {
      return `API keys sent in a ${String(scheme.in)} are not supported`;
    }
    const placement = SecretPlacement.safeParse({ in: scheme.in, name: scheme.name });
    return placement.success
      ? placement.data
      : `API key ${String(scheme.in)} "${String(scheme.name)}" is not supported`;
  }
  return `${String(scheme.type)} security is not supported`;
}

/** How callers authenticate, or why none of the allowed ways can be used. */
function security(requirements: unknown, schemes: Json): Operation["security"] | string {
  if (!Array.isArray(requirements) || requirements.length === 0) return { kind: "none" };
  // Any alternative that is `{}` means anonymous access is allowed.
  if (requirements.some((r) => isObject(r) && Object.keys(r).length === 0)) return { kind: "none" };
  let apiKey: Extract<Operation["security"], { kind: "api-key" }> | undefined;
  let unsupported: string | undefined;
  for (const requirement of requirements) {
    if (!isObject(requirement)) continue;
    const names = Object.keys(requirement);
    if (names.length > 1) {
      // Several schemes at once (key AND user): only one credential is ever sent.
      unsupported ??= `it needs ${names.join(" and ")} together, which is not supported`;
      continue;
    }
    for (const [name, scopes] of Object.entries(requirement)) {
      const scheme = schemes[name];
      if (!isObject(scheme) || typeof scheme.type !== "string") {
        // Never anonymous by accident: an undefined scheme still means sign-in is needed.
        unsupported ??= `its security scheme "${name}" is not defined`;
        continue;
      }
      if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        // A signed-in user beats a shared key: actions run as that user (A2).
        return { kind: "user", scopes: Array.isArray(scopes) ? (scopes as string[]) : [] };
      }
      const placement = placementOf(scheme);
      if (typeof placement === "string") unsupported ??= placement;
      else
        apiKey ??= {
          kind: "api-key",
          scheme: name,
          // Bearer is what a tenant secret means when nothing else is said.
          ...(placement.in === "authorization" && placement.scheme === "bearer"
            ? {}
            : { placement }),
        };
    }
  }
  return apiKey ?? unsupported ?? { kind: "none" };
}

/**
 * Why the executor cannot send a parameter the way the spec describes it, if it cannot.
 * It sends path values plainly, query scalars and arrays of scalars as `name=value`
 * (repeated for an array), and anything else as one JSON value.
 */
/**
 * Header parameters the OpenAPI Parameter Object says to ignore. `Authorization` is ignored
 * too by the spec, but stays: the credential checks below must still see it.
 */
const IGNORED_HEADERS = new Set(["accept", "content-type"]);

/** `example`, or the first `examples` entry's `value` (OpenAPI Example Objects). */
function parameterExample(p: Json): unknown {
  if (p.example !== undefined) return p.example;
  if (!isObject(p.examples)) return undefined;
  const first = Object.values(p.examples)[0];
  return isObject(first) ? first.value : undefined;
}

function unsupportedEncoding(p: Json, schema: Schema, json: boolean): string | undefined {
  const name = String(p.name);
  const s = objectSchema(schema);
  const object = s.type === "object" || (s.type === undefined && isObject(s.properties));
  const array = s.type === "array";
  const scalarItems =
    isObject(s.items) && ["string", "number", "integer", "boolean"].includes(String(s.items.type));
  if (p.in === "path") {
    const style = p.style ?? "simple";
    if (object || array) return `path parameter "${name}" is not a single value`;
    return style === "simple" ? undefined : `path parameter "${name}" uses ${String(style)} style`;
  }
  if (json) {
    // A JSON string would arrive quoted; the executor sends strings as they are.
    return s.type === "string" ? `query parameter "${name}" is a JSON-encoded string` : undefined;
  }
  const style = p.style ?? "form";
  const explode = p.explode ?? style === "form";
  if (object) return `query parameter "${name}" is an object sent as ${String(style)} fields`;
  if (array && (style !== "form" || explode !== true || !scalarItems)) {
    return `query parameter "${name}" is a list sent in ${String(style)} style${explode ? "" : " without explode"}`;
  }
  return undefined;
}

export async function importOpenApi(
  input: string | object,
  options: OpenApiImportOptions = {},
): Promise<OpenApiImportResult> {
  const { doc, text } = parseDocument(input);
  const version = typeof doc.openapi === "string" ? doc.openapi : "";
  if (!/^3\.[01]\.\d+/.test(version)) {
    throw new Error(
      typeof doc.swagger === "string"
        ? "Swagger 2.0 is not supported: convert it to OpenAPI 3 first"
        : "not an OpenAPI 3.0 or 3.1 document",
    );
  }
  const v30 = version.startsWith("3.0");
  const resolver = new Resolver(doc, v30);
  const document = await sha256Text(text);

  const base = server(doc.servers);
  const apiOrigin = options.apiOrigin
    ? new URL(options.apiOrigin).origin
    : base && base.protocol !== "relative:"
      ? base.origin
      : undefined;
  if (!apiOrigin)
    throw new Error("the document has no absolute servers[0] URL: pass the API origin");
  // Paths and operations may name their own servers; they must be on the same origin.
  const origin = base && base.protocol !== "relative:" ? base.origin : apiOrigin;

  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes)
    ? Object.fromEntries(
        Object.entries(components.securitySchemes).map(([k, v]) => [k, resolver.deref<Json>(v)]),
      )
    : {};

  const skipped: Skipped[] = [];
  const capabilities: Capability[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const rawPath of Object.keys(paths).sort()) {
    let item: Json;
    try {
      item = resolver.deref<Json>(paths[rawPath]);
    } catch (error) {
      skipped.push({ method: "*", path: rawPath, reason: (error as Error).message });
      continue;
    }
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method.toLowerCase()];
      if (!isObject(operation)) continue;
      const where = server(operation.servers) ?? server(item.servers) ?? base;
      const basePath = (where?.pathname ?? "").replace(/\/+$/, "");
      const fullPath = `${basePath}${rawPath}`;
      const skip = (reason: string) => skipped.push({ method, path: fullPath, reason });
      if (where && where.protocol !== "relative:" && where.origin !== origin) {
        skip(`it is served from ${where.origin}, not ${origin}`);
        continue;
      }
      resolver.reset();
      try {
        const op = toOperation(method, fullPath, item, operation, resolver, doc, schemes);
        if (typeof op === "string") {
          skip(op);
          continue;
        }
        const built = toCapability(op, {
          source: { kind: "openapi", document },
          apiOrigin,
          confidence: 0.9,
        });
        if ("reason" in built) skipped.push(built);
        else capabilities.push(built);
      } catch (error) {
        skip(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return {
    capabilities: dedupeIds(capabilities),
    skipped,
    apiOrigin,
    document,
    version: v30 ? "3.0" : "3.1",
  };
}

function toOperation(
  method: Method,
  path: string,
  item: Json,
  operation: Json,
  resolver: Resolver,
  doc: Json,
  schemes: Json,
): Operation | string {
  if (operation.deprecated === true) return "the operation is deprecated";
  const auth = security(operation.security ?? doc.security, schemes);
  if (typeof auth === "string") return auth;
  // A key sent in the query is the credential's to fill, never an input.
  const secretParam =
    auth.kind === "api-key" && auth.placement?.in === "query" ? auth.placement.name : undefined;

  // Operation-level parameters override path-level ones with the same name and location.
  const params = new Map<string, Json>();
  for (const list of [item.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = resolver.deref<Json>(raw);
      if (!isObject(p) || typeof p.name !== "string") continue;
      // OpenAPI 3: these header parameters "SHALL be ignored"; the executor sets them itself.
      if (p.in === "header" && IGNORED_HEADERS.has(p.name.toLowerCase())) continue;
      params.set(`${p.in}:${p.name}`, p);
    }
  }

  let template = path;
  const pathParams: Param[] = [];
  const query: Param[] = [];
  for (const p of params.values()) {
    const name = p.name as string;
    const description = typeof p.description === "string" ? p.description : undefined;
    const viaContent = p.schema === undefined && p.content !== undefined;
    const media = viaContent ? jsonContent(p.content) : undefined;
    if (viaContent && !media) {
      if (p.required === true) return `parameter "${name}" is not JSON`;
      continue;
    }
    const plain = objectSchema(resolver.schema(p.schema ?? media?.schema ?? { type: "string" }));
    // A parameter's own example sits beside its schema; carry it in, as for schema `example`.
    const example = parameterExample(p) ?? parameterExample(media ?? {});
    const schema =
      example !== undefined && plain.examples === undefined
        ? { ...plain, examples: [example] }
        : plain;
    if (p.in === "path" || p.in === "query") {
      const unsupported = unsupportedEncoding(p, schema, viaContent);
      if (unsupported) {
        // An optional parameter the executor cannot encode is left out, not the operation.
        if (p.in === "path" || p.required === true) return `${unsupported}, which is not supported`;
        continue;
      }
    }
    const param = (as: string, required: boolean): Param => ({
      name: as,
      schema,
      required,
      ...(description ? { description } : {}),
    });
    if (p.in === "path") {
      // Input names are snake_case; the template follows. Only the path text changes.
      let as = snake(name) || "id";
      if (!/^[a-z_]/.test(as)) as = `p_${as}`;
      template = template.replaceAll(`{${name}}`, `{${as}}`);
      pathParams.push(param(as, true));
    } else if (p.in === "query") {
      if (name === secretParam) continue;
      query.push(param(name, p.required === true));
    } else if (
      (p.in === "header" || p.in === "cookie") &&
      p.required === true &&
      !isCredentialName(name)
    ) {
      return `needs ${p.in} "${name}", which is not supported yet`;
    }
  }
  const missing = [...template.matchAll(/\{([^}]+)\}/g)]
    .map((m) => m[1])
    .filter((v) => !pathParams.some((p) => p.name === v));
  if (missing.length > 0) return `path variable "${missing[0]}" has no parameter`;

  let body: Json | undefined;
  if (operation.requestBody !== undefined) {
    const requestBody = resolver.deref<Json>(operation.requestBody);
    const media = jsonContent(requestBody.content, true);
    if (!media) {
      const other = isObject(requestBody.content)
        ? Object.keys(requestBody.content).find((t) => /\+json\b/i.test(t))
        : undefined;
      if (other) return `the request body is sent as ${other}, not application/json`;
      if (requestBody.required === true) return "the request body is not JSON";
    } else if (BODY_METHODS.has(method)) {
      const schema = objectSchema(
        mergeAllOf(without(resolver.schema(media.schema ?? {}), "readOnly")),
      );
      if (schema.type !== "object" && !isObject(schema.properties))
        return "the request body is not a JSON object";
      // Tools take the body's named fields. Without any, a oneOf or a free-form map would
      // become a tool that can send nothing.
      const named = isObject(schema.properties) && Object.keys(schema.properties).length > 0;
      const open =
        schema.oneOf !== undefined ||
        schema.anyOf !== undefined ||
        schema.patternProperties !== undefined ||
        (schema.additionalProperties !== undefined && schema.additionalProperties !== false);
      if (open && !named) {
        return "the request body's fields cannot be listed (oneOf, anyOf or a free-form map)";
      }
      body = schema;
    }
  } else if (BODY_METHODS.has(method)) {
    body = { type: "object", properties: {} };
  }

  let output: Json | undefined;
  const responses = isObject(operation.responses) ? operation.responses : {};
  const success = Object.keys(responses)
    .filter((code) => /^2(?:\d\d|XX)$/i.test(code))
    .sort()[0];
  if (success) {
    const media = jsonContent(resolver.deref<Json>(responses[success])?.content);
    if (media?.schema !== undefined) {
      output = objectSchema(mergeAllOf(without(resolver.schema(media.schema), "writeOnly")));
    }
  }

  return {
    method,
    path: template,
    pathParams,
    query,
    ...(body ? { body } : {}),
    ...(output ? { output } : {}),
    ...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}),
    ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
    ...(typeof operation.description === "string" ? { description: operation.description } : {}),
    ...(Array.isArray(operation.tags) ? { tags: operation.tags as string[] } : {}),
    security: auth,
  };
}
