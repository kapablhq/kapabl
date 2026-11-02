// SPDX-License-Identifier: Apache-2.0
// Approved http capabilities → an OpenAPI 3.1 description of the tenant's own API
// (AGENTS.md H5: 3.1 only, JSON Schema 2020-12 dialect). It describes calls as the
// executor makes them (`originRequest` in @kapabl/graph): path variables in the path,
// the other inputs in the query for GET/DELETE and in a JSON body otherwise, except the
// ones the executor sends in the query. Owner-reviewed, so it can stand in for a spec the
// tenant never wrote.

import { type Capability, pathVariables } from "@kapabl/graph";

export interface OpenApiInfo {
  title: string;
  version: string;
  /** Where the API lives: the `servers` entry. */
  apiOrigin: string;
}

export interface OpenApiOutput {
  document: Record<string, unknown>;
  /** Capabilities left out, with the reason. */
  skipped: { id: string; reason: string }[];
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** Top-level keywords that constrain inputs across properties; query parameters cannot carry them. */
const CROSS_PROPERTY = [
  "enum",
  "const",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
];

type Schema = Record<string, unknown>;
type HttpCapability = Capability & { executor: Extract<Capability["executor"], { kind: "http" }> };

/** Local `$ref`s in a tool schema point into that schema; in OpenAPI they would point at the document root. */
function hasRef(schema: unknown): boolean {
  return JSON.stringify(schema ?? {}).includes('"$ref"');
}

const isScalarValue = (v: unknown) => v !== null && typeof v !== "object";

/** The JSON types a schema allows, or undefined when it does not say. */
function types(schema: Schema): Set<string> | undefined {
  if (Array.isArray(schema.enum)) return new Set(schema.enum.map(jsonType));
  if ("const" in schema) return new Set([jsonType(schema.const)]);
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type as string[]);
  const branches = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(branches) && branches.length > 0) {
    const all = new Set<string>();
    for (const branch of branches) {
      const t = branch !== null && typeof branch === "object" ? types(branch as Schema) : undefined;
      if (!t) return undefined;
      for (const type of t) all.add(type);
    }
    return all;
  }
  return undefined;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return isScalarValue(value) ? (typeof value === "number" ? "number" : typeof value) : "object";
}

/**
 * How the executor sends a query value of this schema, decided by the same rule it applies
 * to the value (`originRequest`): scalars as `name=value`, arrays of scalars exploded
 * (`name=a&name=b`), anything else as one JSON value; null is not sent. Undefined when
 * values the schema allows would go more than one way.
 */
function queryStyle(schema: unknown): "form" | "json" | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const t = types(schema as Schema);
  if (!t) return undefined;
  t.delete("null");
  const scalar = [...t].every((type) => SCALAR_TYPES.has(type));
  if (t.size > 0 && scalar) return "form";
  if (t.size === 1 && t.has("object")) return "json";
  if (t.size === 1 && t.has("array")) {
    // Every item, positional ones included, decides how the array is sent.
    const s = schema as Schema;
    const parts = [...(Array.isArray(s.prefixItems) ? s.prefixItems : []), s.items];
    const itemTypes = new Set<string>();
    for (const part of parts) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) return undefined;
      const each = types(part as Schema);
      if (!each) return undefined;
      for (const type of each) itemTypes.add(type);
    }
    // An empty array sends nothing either way; a null item is not a scalar.
    if ([...itemTypes].every((type) => SCALAR_TYPES.has(type))) return "form";
    if (![...itemTypes].some((type) => SCALAR_TYPES.has(type))) return "json";
  }
  return undefined;
}

/** A query parameter as the executor sends it (see `queryStyle`). */
function queryParameter(name: string, prop: Schema, required: boolean): Schema {
  const { description, ...schema } = prop as Schema;
  const json = queryStyle(prop) === "json";
  return {
    name,
    in: "query",
    required,
    ...(json ? { content: { "application/json": { schema } } } : { schema }),
    ...(typeof description === "string" ? { description } : {}),
  };
}

/** The security scheme a capability's origin credential corresponds to, by component name. */
function securityScheme(capability: HttpCapability): { name: string; scheme: Schema } | undefined {
  const credential = capability.executor.credential;
  if (credential.kind === "token-exchange") {
    return {
      name: "userToken",
      scheme: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "A short-lived token for the signed-in user, issued for this API's audience.",
      },
    };
  }
  if (credential.kind !== "tenant-secret") return undefined;
  const placement = credential.placement ?? { in: "authorization", scheme: "bearer" };
  const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");
  switch (placement.in) {
    case "authorization":
      return placement.scheme === "basic"
        ? {
            name: "basicAuth",
            scheme: { type: "http", scheme: "basic", description: "The site's credentials." },
          }
        : {
            name: "apiKey",
            scheme: { type: "http", scheme: "bearer", description: "The site's API key." },
          };
    case "header":
    case "query":
      return {
        name: `apiKey_${placement.in}_${safe(placement.name)}`,
        scheme: {
          type: "apiKey",
          in: placement.in,
          name: placement.name,
          description: "The site's API key.",
        },
      };
  }
}

/** `/orders/{id}` and `/orders/{order_id}` are the same path to OpenAPI 3.1. */
function pathShape(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

export function openApiDocument(
  info: OpenApiInfo,
  capabilities: readonly Capability[],
): OpenApiOutput {
  const paths: Record<string, Record<string, unknown>> = {};
  const byShape = new Map<string, string>();
  const skipped: OpenApiOutput["skipped"] = [];
  const securitySchemes: Record<string, Schema> = {};

  for (const capability of [...capabilities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const executor = capability.executor;
    if (executor.kind !== "http") {
      skipped.push({ id: capability.id, reason: "not an http capability" });
      continue;
    }
    if (hasRef(capability.inputSchema) || hasRef(capability.outputSchema)) {
      skipped.push({
        id: capability.id,
        reason: "its schemas use $ref, which OpenAPI would resolve differently",
      });
      continue;
    }
    const method = executor.method.toLowerCase();
    const described = byShape.get(pathShape(executor.path));
    if (described !== undefined && described !== executor.path) {
      skipped.push({
        id: capability.id,
        reason: `${executor.path} is already described as ${described}`,
      });
      continue;
    }
    if (paths[executor.path]?.[method]) {
      skipped.push({
        id: capability.id,
        reason: `${executor.method} ${executor.path} is already described`,
      });
      continue;
    }

    const input = capability.inputSchema as Schema;
    const { properties: allProperties, required: allRequired, ...keywords } = input;
    const properties = (allProperties ?? {}) as Record<string, Schema>;
    const required = new Set((allRequired ?? []) as string[]);
    const pathNames = new Set(pathVariables(executor.path));
    const hasBody = BODY_METHODS.has(executor.method);
    const inQuery = new Set(executor.query ?? []);
    // Inputs split between the body and the path or query cannot be constrained together.
    if (!hasBody || inQuery.size > 0 || pathNames.size > 0) {
      const crossProperty = CROSS_PROPERTY.filter((k) => k in keywords);
      if (crossProperty.length > 0) {
        skipped.push({
          id: capability.id,
          reason: `its input schema uses ${crossProperty.join(", ")}, which cannot hold across inputs sent in the path or query`,
        });
        continue;
      }
    }

    const queryNames = Object.keys(properties).filter(
      (n) => !pathNames.has(n) && (!hasBody || inQuery.has(n)),
    );
    const undecided = queryNames.filter((n) => !queryStyle(properties[n]));
    if (undecided.length > 0) {
      skipped.push({
        id: capability.id,
        reason: `the query parameters ${undecided.join(", ")} are sent in more than one form depending on the value`,
      });
      continue;
    }

    const parameters: Schema[] = [];
    for (const name of pathNames) {
      const { description, ...schema } = properties[name] ?? { type: "string" };
      parameters.push({
        name,
        in: "path",
        required: true,
        schema,
        ...(typeof description === "string" ? { description } : {}),
      });
    }
    const bodyProperties: [string, Schema][] = [];
    for (const [name, prop] of Object.entries(properties)) {
      if (pathNames.has(name)) continue;
      if (hasBody && !inQuery.has(name)) bodyProperties.push([name, prop]);
      else parameters.push(queryParameter(name, prop, required.has(name)));
    }
    let requestBody: Schema | undefined;
    if (hasBody) {
      const bodyRequired = bodyProperties.map(([name]) => name).filter((n) => required.has(n));
      requestBody = {
        required: true,
        content: {
          "application/json": {
            // The input schema's other keywords (additionalProperties, oneOf, ...) apply to
            // the body as they do to the tool's input.
            schema: {
              ...keywords,
              type: "object",
              properties: Object.fromEntries(bodyProperties),
              ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
            },
          },
        },
      };
    }

    const scheme = securityScheme(capability as HttpCapability);
    if (scheme) {
      // Header names like `X*Key` and `X+Key` share a component name once made safe.
      const base = scheme.name;
      for (let n = 2; securitySchemes[scheme.name] !== undefined; n++) {
        if (JSON.stringify(securitySchemes[scheme.name]) === JSON.stringify(scheme.scheme)) break;
        scheme.name = `${base}_${n}`;
      }
      securitySchemes[scheme.name] = scheme.scheme;
    }
    byShape.set(pathShape(executor.path), executor.path);
    paths[executor.path] ??= {};
    (paths[executor.path] as Record<string, unknown>)[method] = {
      operationId: capability.id,
      summary: capability.title,
      description: capability.description,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        "2XX": {
          description: "Success",
          ...(capability.outputSchema
            ? { content: { "application/json": { schema: capability.outputSchema } } }
            : {}),
        },
      },
      security: scheme ? [{ [scheme.name]: [] }] : [],
    };
  }

  const sortedPaths = Object.fromEntries(
    Object.keys(paths)
      .sort()
      .map((p) => [p, paths[p]]),
  );
  const sortedSchemes = Object.fromEntries(
    Object.keys(securitySchemes)
      .sort()
      .map((name) => [name, securitySchemes[name]]),
  );
  return {
    document: {
      openapi: "3.1.1",
      jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
      info: { title: info.title, version: info.version },
      servers: [{ url: info.apiOrigin }],
      paths: sortedPaths,
      ...(Object.keys(sortedSchemes).length > 0
        ? { components: { securitySchemes: sortedSchemes } }
        : {}),
    },
    skipped,
  };
}
