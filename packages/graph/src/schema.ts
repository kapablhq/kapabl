// SPDX-License-Identifier: Apache-2.0
// The capability graph: one reviewed, typed description of what an agent can do
// on a tenant's site. Every agent-facing surface is emitted from it (AGENTS.md §2).

import { z } from "zod";
import { BODY_METHODS, pathVariables } from "./origin.ts";

export const GRAPH_FORMAT_VERSION = 1;

/** Names reserved for the MCP meta-tools that front read-only capabilities. */
export const RESERVED_TOOL_NAMES = ["search", "execute"] as const;

/** snake_case, at most 64 characters, header-safe. Doubles as the MCP tool name. */
export const CapabilityId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "must be snake_case, start with a letter, at most 64 chars")
  .refine((id) => !(RESERVED_TOOL_NAMES as readonly string[]).includes(id), {
    message: `must not be a reserved tool name (${RESERVED_TOOL_NAMES.join(", ")})`,
  })
  .meta({
    description: "Stable id, also the MCP tool name: snake_case, at most 64 characters.",
    not: { enum: [...RESERVED_TOOL_NAMES] },
  });

export const TenantId = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "must be a lowercase DNS-label-style slug")
  .meta({ description: "Tenant slug. Part of every storage key." });

export const Sha256Digest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex chars>");

export const HttpMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/** read: no side effects. write: changes state. destructive: deletes, cancels, refunds, pays or transfers. */
export const SideEffect = z
  .enum(["read", "write", "destructive"])
  .meta({ description: "read | write | destructive. Anything but read becomes its own MCP tool." });

export const ApprovalStatus = z
  .enum(["pending", "approved", "rejected"])
  .meta({ description: "Only approved capabilities are ever emitted." });

/**
 * Structural check of a JSON Schema 2020-12 document: every applicator holds a
 * schema, every keyword has the 2020-12 type. Unknown keywords are allowed, as the
 * spec requires. Pure Zod, so it also runs inside Workers (no code generation).
 */
export type JsonSchemaNode = boolean | { [keyword: string]: unknown };

const JSON_TYPES = ["array", "boolean", "integer", "null", "number", "object", "string"] as const;
const TypeName = z.enum(JSON_TYPES);
const NonNegativeInt = z.int().min(0);
const unique = (items: readonly unknown[]) => new Set(items).size === items.length;

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

const SchemaNode: z.ZodType<JsonSchemaNode> = z.lazy(() => z.union([z.boolean(), SchemaObject]));
const SchemaMap = z.lazy(() => z.record(z.string(), SchemaNode));
/** patternProperties: every key is itself a regular expression. */
const PatternMap = z.lazy(() =>
  z.record(
    z.string().refine(isValidRegex, "must be a valid ECMA-262 regular expression"),
    SchemaNode,
  ),
);
const SchemaList = z.lazy(() => z.array(SchemaNode).min(1));

const SchemaObject = z.looseObject({
  $schema: z.literal("https://json-schema.org/draft/2020-12/schema").optional(),
  // Tool schemas are self-contained. $id would rebase "#..." refs onto a remote document,
  // and dynamic refs can point anywhere, so all of them are refused.
  $id: z.never({ error: "is not allowed; tool schemas are self-contained" }).optional(),
  $dynamicRef: z.never({ error: "is not allowed; tool schemas are self-contained" }).optional(),
  $dynamicAnchor: z.never({ error: "is not allowed" }).optional(),
  $recursiveRef: z.never({ error: "is not allowed" }).optional(),
  $anchor: z
    .string()
    .regex(/^[A-Za-z_][-A-Za-z0-9._]*$/)
    .optional(),
  $comment: z.string().optional(),
  $ref: z
    .string()
    .regex(/^#/, "must be a local reference (#...); remote schemas are never fetched")
    .optional(),
  $defs: SchemaMap.optional(),
  definitions: SchemaMap.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  type: z
    .union([TypeName, z.array(TypeName).min(1).refine(unique, "must not repeat a type")])
    .optional(),
  enum: z.array(z.unknown()).min(1).optional(),
  properties: SchemaMap.optional(),
  patternProperties: PatternMap.optional(),
  additionalProperties: SchemaNode.optional(),
  propertyNames: SchemaNode.optional(),
  required: z.array(z.string()).refine(unique, "must not repeat a property").optional(),
  items: SchemaNode.optional(),
  prefixItems: SchemaList.optional(),
  contains: SchemaNode.optional(),
  allOf: SchemaList.optional(),
  anyOf: SchemaList.optional(),
  oneOf: SchemaList.optional(),
  not: SchemaNode.optional(),
  if: SchemaNode.optional(),
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword; its value is a schema, never a function.
  then: SchemaNode.optional(),
  else: SchemaNode.optional(),
  pattern: z
    .string()
    .refine(isValidRegex, "must be a valid ECMA-262 regular expression")
    .optional(),
  format: z.string().optional(),
  minLength: NonNegativeInt.optional(),
  maxLength: NonNegativeInt.optional(),
  minItems: NonNegativeInt.optional(),
  maxItems: NonNegativeInt.optional(),
  minProperties: NonNegativeInt.optional(),
  maxProperties: NonNegativeInt.optional(),
  uniqueItems: z.boolean().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
  minContains: NonNegativeInt.optional(),
  maxContains: NonNegativeInt.optional(),
  dependentSchemas: SchemaMap.optional(),
  dependentRequired: z.record(z.string(), z.array(z.string())).optional(),
  unevaluatedProperties: SchemaNode.optional(),
  unevaluatedItems: SchemaNode.optional(),
  contentSchema: SchemaNode.optional(),
  contentEncoding: z.string().optional(),
  contentMediaType: z.string().optional(),
  readOnly: z.boolean().optional(),
  writeOnly: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  examples: z.array(z.unknown()).optional(),
});

/** A JSON Schema 2020-12 object schema, as MCP requires for tool input. */
export const ObjectJsonSchema = SchemaObject.extend({ type: z.literal("object") }).meta({
  description: "JSON Schema 2020-12 describing a JSON object.",
});

/** Any JSON Schema 2020-12 schema (object form). */
export const JsonSchema = SchemaObject.meta({ description: "JSON Schema 2020-12." });

/** How the end user (or anonymous agent) must be authorized to call the capability. */
export const Auth = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("oauth"),
    scopes: z
      .array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "must be an RFC 6749 scope token"))
      .min(1),
  }),
]);

/** Headers the runtime or the request itself controls; a secret never goes in one of them. */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "traceparent",
  "transfer-encoding",
]);

/**
 * Where the origin expects a tenant secret (OpenAPI `apiKey` and `http` schemes). Absent
 * means `Authorization: Bearer <secret>`. For `basic`, the secret is `user:password`.
 */
export const SecretPlacement = z.discriminatedUnion("in", [
  z.strictObject({ in: z.literal("authorization"), scheme: z.enum(["bearer", "basic"]) }),
  z.strictObject({
    in: z.literal("header"),
    name: z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "must be an HTTP field name")
      .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "is a reserved header"),
  }),
  z.strictObject({
    in: z.literal("query"),
    name: z.string().regex(/^[A-Za-z0-9._~-]+$/, "must be a plain query parameter name"),
  }),
]);

/**
 * The credential used to call the tenant's origin. There is deliberately no
 * option to forward the agent's inbound token.
 */
export const OriginCredential = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("token-exchange"), audience: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("tenant-secret"),
    // The edge resolves only TENANT_* Worker secrets, so a graph can never name a platform
    // secret such as REQUEST_STATE_KEY (A2, S1).
    secretRef: z
      .string()
      .max(64)
      .regex(
        /^TENANT_[A-Z0-9_]+$/,
        "must be a TENANT_ UPPER_SNAKE secret name, never the secret itself",
      ),
    placement: SecretPlacement.optional(),
  }),
]);

/** Characters allowed in a path segment (RFC 3986 pchar), plus `{name}` variables. */
const SEGMENT = String.raw`(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2}|\{[A-Za-z_][A-Za-z0-9_]*\})+`;
const PATH_TEMPLATE = new RegExp(`^(?:/|(?:/${SEGMENT})+/?)$`);

/**
 * RFC 6570 level-1 path template relative to the tenant origin, e.g. /v1/orders/{order_id}.
 * Empty segments are rejected, so a path can never start with `//` and resolve to another
 * host when joined to the origin; `.` and `..` segments are rejected too.
 */
export const PathTemplate = z
  .string()
  .regex(PATH_TEMPLATE, "must be an origin-relative path template like /v1/orders/{order_id}")
  .refine((path) => !path.split("/").some((seg) => seg === "." || seg === ".."), {
    message: "must not contain . or .. segments",
  })
  .refine((path) => !/%(?:2e|2f|5c)/i.test(path), {
    // URL parsers turn %2e%2e into a dot segment, and some origins decode %2f and %5c.
    message: "must not percent-encode '.', '/' or '\\'",
  })
  .meta({ not: { pattern: String.raw`(?:^|/)\.\.?(?:/|$)|%(?:2[eEfF]|5[cC])` } });

export const Executor = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    method: HttpMethod,
    path: PathTemplate,
    /** POST, PUT and PATCH only: inputs sent in the query string instead of the JSON body. */
    query: z.array(z.string().min(1)).min(1).refine(unique, "must not repeat an input").optional(),
    credential: OriginCredential,
    timeoutMs: z.int().min(100).max(30_000).optional(),
  }),
  z.strictObject({
    kind: z.literal("browser"),
    workflow: z.string().min(1),
    workflowVersion: z.int().min(1),
  }),
]);

/** Per-call price. Payment goes to the tenant's own wallet or PSP account. */
export const Price = z.strictObject({
  amount: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, "must be a decimal string, e.g. 0.01")
    .refine((amount) => /[1-9]/.test(amount), "must be more than 0; a free action has no price")
    .meta({ not: { pattern: String.raw`^0(?:\.0*)?$` } }),
  currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code, e.g. USD"),
});

/** Where a capability came from, so reviewers can trace it. */
export const Provenance = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("openapi"),
    document: Sha256Digest,
    operationId: z.string().min(1).optional(),
    method: HttpMethod,
    path: PathTemplate,
  }),
  z.strictObject({
    source: z.literal("har"),
    capture: Sha256Digest,
    method: HttpMethod,
    path: PathTemplate,
    samples: z.int().min(1),
  }),
  z.strictObject({ source: z.literal("manual") }),
]);

/** Text agents read: must contain something other than whitespace. */
const NonBlank = /\S/;

/** Resolve a local `$ref` ("#", "#/json/pointer" or "#anchor") inside `root`. */
function resolvesLocally(root: JsonSchemaNode, ref: string): boolean {
  const fragment = ref.slice(1);
  if (fragment === "") return true;
  if (!fragment.startsWith("/")) {
    let found = false;
    walkSchema(root, (node) => {
      if (node.$anchor === fragment) found = true;
    });
    return found;
  }
  // Only through schema keywords: validators index subschemas, not data (`#/required`,
  // `#/properties/a/default`) or unknown keywords, so a ref there throws on every call.
  // And only as the validator spells it: it indexes `encodeURI` of each escaped name and
  // looks refs up by URL, which leaves `{`, `|`, `^` and `\\` unencoded.
  const tokens: string[] = [];
  for (const raw of fragment.slice(1).split("/")) {
    let token: string;
    try {
      token = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return false;
    }
    const indexed = encodeURI(token.replace(/~/g, "~0").replace(/\//g, "~1"));
    if (new URL(`#${raw}`, "https://x.invalid/").hash.slice(1) !== indexed) return false;
    tokens.push(token);
  }
  let node: unknown = root;
  for (let i = 0; i < tokens.length; i++) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
    const keyword = tokens[i] as string;
    const value = Object.hasOwn(node, keyword)
      ? (node as Record<string, unknown>)[keyword]
      : undefined;
    if ((SUBSCHEMA_ONE as readonly string[]).includes(keyword)) {
      node = value;
    } else if ((SUBSCHEMA_LIST as readonly string[]).includes(keyword)) {
      const index = tokens[++i];
      if (!Array.isArray(value) || index === undefined || !/^(?:0|[1-9]\d*)$/.test(index))
        return false;
      node = value[Number(index)];
    } else if ((SUBSCHEMA_MAP as readonly string[]).includes(keyword)) {
      const name = tokens[++i];
      if (value === null || typeof value !== "object" || name === undefined) return false;
      if (!Object.hasOwn(value, name)) return false;
      node = (value as Record<string, unknown>)[name];
    } else {
      return false;
    }
  }
  return typeof node === "boolean" || (node !== null && typeof node === "object");
}

/** What the edge's validator (@cfworker/json-schema) does not descend into. */
const VALIDATOR_IGNORES = new Set([
  "id",
  "$id",
  "$ref",
  "$schema",
  "$anchor",
  "$vocabulary",
  "$comment",
  "default",
  "enum",
  "const",
  "required",
  "type",
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxProperties",
  "minProperties",
]);
const VALIDATOR_ARRAYS = new Set(["prefixItems", "items", "allOf", "anyOf", "oneOf"]);

/**
 * Base-URI and anchor keywords the edge's validator would act on, wherever it looks: it
 * reads `$id` and `id` on every object it descends into, unknown keywords included, so
 * `"x-note": {"$id": ".../#/$defs/Amt"}` would silently replace what a `$ref` points at.
 * Anchors outside schema positions would do the same. Returns where each one is.
 */
export function rebasingKeywords(schema: JsonSchemaNode): string[] {
  const schemas = new Set<object>();
  walkSchema(schema, (node) => {
    schemas.add(node);
  });
  const found: string[] = [];
  const visit = (value: unknown, at: string): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    for (const key of ["$id", "id"]) if (node[key]) found.push(`${at}/${key}`);
    if (node.$anchor !== undefined && !schemas.has(node)) found.push(`${at}/$anchor`);
    for (const [key, sub] of Object.entries(node)) {
      if (VALIDATOR_IGNORES.has(key)) continue;
      if (Array.isArray(sub)) {
        if (VALIDATOR_ARRAYS.has(key))
          for (const [i, item] of sub.entries()) visit(item, `${at}/${key}/${i}`);
      } else if (
        (SUBSCHEMA_MAP as readonly string[]).includes(key) &&
        sub &&
        typeof sub === "object"
      ) {
        for (const [name, item] of Object.entries(sub)) visit(item, `${at}/${key}/${name}`);
      } else {
        visit(sub, `${at}/${key}`);
      }
    }
  };
  visit(schema, "#");
  return found;
}

/** Characters a name must not hold: they would forge lines on the review screen. */
const UNPRINTABLE_NAME = /[\p{Cc}\u2028\u2029]/u;

/** Property and definition names, and `required` entries, that hold control characters. */
export function unprintableNames(schema: JsonSchemaNode): string[] {
  const bad: string[] = [];
  walkSchema(schema, (node) => {
    for (const key of SUBSCHEMA_MAP) {
      const map = node[key];
      if (map !== null && typeof map === "object")
        bad.push(...Object.keys(map).filter((n) => UNPRINTABLE_NAME.test(n)));
    }
    if (Array.isArray(node.required))
      bad.push(...node.required.filter((n) => typeof n === "string" && UNPRINTABLE_NAME.test(n)));
  });
  return bad;
}

/** JSON Schema 2020-12 keywords whose value is one subschema. */
export const SUBSCHEMA_ONE = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contains",
  "contentSchema",
  "not",
  "if",
  "then",
  "else",
] as const;
/** Keywords whose value is a list of subschemas. */
export const SUBSCHEMA_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
/** Keywords whose value maps names to subschemas. */
export const SUBSCHEMA_MAP = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
] as const;

/**
 * Visit every subschema of a schema, by keyword: values under `enum`, `const`, `default`
 * and `examples` are data, not schemas, even when they look like one.
 */
export function walkSchema(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const node = value as Record<string, unknown>;
  visit(node);
  for (const key of SUBSCHEMA_ONE) walkSchema(node[key], visit);
  for (const key of SUBSCHEMA_LIST) {
    const list = node[key];
    if (Array.isArray(list)) for (const sub of list) walkSchema(sub, visit);
  }
  for (const key of SUBSCHEMA_MAP) {
    const map = node[key];
    if (map !== null && typeof map === "object" && !Array.isArray(map))
      for (const sub of Object.values(map)) walkSchema(sub, visit);
  }
}

/** Local `$ref`s in `schema` that point at nothing, so every validation would throw. */
export function danglingRefs(schema: JsonSchemaNode): string[] {
  const dangling: string[] = [];
  walkSchema(schema, (node) => {
    if (typeof node.$ref === "string" && !resolvesLocally(schema, node.$ref))
      dangling.push(node.$ref);
  });
  return dangling;
}

export const Capability = z
  .strictObject({
    id: CapabilityId,
    title: z.string().min(1).max(120).regex(NonBlank, "must not be blank"),
    description: z
      .string()
      .min(1)
      .max(2000)
      .regex(NonBlank, "must not be blank")
      .meta({ description: "Facts about what the capability does. Never instructions to agents." }),
    sideEffect: SideEffect,
    inputSchema: ObjectJsonSchema,
    outputSchema: ObjectJsonSchema.optional(),
    auth: Auth,
    executor: Executor,
    price: Price.optional(),
    provenance: Provenance,
    confidence: z.number().min(0).max(1),
    approval: ApprovalStatus,
  })
  .superRefine((capability, ctx) => {
    // Anonymous agents must never be able to cancel, refund or delete.
    if (capability.sideEffect === "destructive" && capability.auth.kind === "none") {
      ctx.addIssue({
        code: "custom",
        message: "destructive capabilities require oauth",
        path: ["auth"],
      });
    }
    for (const key of ["inputSchema", "outputSchema"] as const) {
      const schema = capability[key];
      for (const ref of schema ? danglingRefs(schema) : []) {
        ctx.addIssue({ code: "custom", message: `$ref "${ref}" resolves to nothing`, path: [key] });
      }
      for (const where of schema ? rebasingKeywords(schema) : []) {
        ctx.addIssue({
          code: "custom",
          message: `${where} would change what $refs resolve to (the validator reads any "id" or "$id" it finds as a schema address)`,
          path: [key],
        });
      }
      for (const name of schema ? unprintableNames(schema) : []) {
        ctx.addIssue({
          code: "custom",
          message: `the name ${JSON.stringify(name)} holds control characters`,
          path: [key],
        });
      }
    }
    // Every path variable must be a required input, or the call cannot be built.
    if (capability.executor.kind === "http") {
      const properties = Object.keys(
        (capability.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      );
      const required = capability.inputSchema.required ?? [];
      for (const name of pathVariables(capability.executor.path)) {
        if (!properties.includes(name) || !required.includes(name)) {
          ctx.addIssue({
            code: "custom",
            message: `path variable "${name}" must be a required property of inputSchema`,
            path: ["executor", "path"],
          });
        }
      }
      const pathNames = new Set(pathVariables(capability.executor.path));
      for (const name of capability.executor.query ?? []) {
        if (!BODY_METHODS.has(capability.executor.method)) {
          ctx.addIssue({
            code: "custom",
            message: `only POST, PUT and PATCH list query inputs; ${capability.executor.method} sends every input in the query`,
            path: ["executor", "query"],
          });
          break;
        }
        if (!properties.includes(name) || pathNames.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `query input "${name}" must be a property of inputSchema and not a path variable`,
            path: ["executor", "query"],
          });
        }
      }
      const credential = capability.executor.credential;
      if (
        credential.kind === "tenant-secret" &&
        credential.placement?.in === "query" &&
        properties.includes(credential.placement.name)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `the secret's query parameter "${credential.placement.name}" is also an input`,
          path: ["executor", "credential"],
        });
      }
    }
  })
  .meta({
    // JSON Schema form of the rule above, for tools that validate graph.json without Zod.
    if: {
      type: "object",
      properties: { sideEffect: { const: "destructive" } },
      required: ["sideEffect"],
    },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword; its value is a schema, never a function.
    then: {
      type: "object",
      properties: { auth: { type: "object", properties: { kind: { const: "oauth" } } } },
    },
  });

export const Graph = z
  .strictObject({
    formatVersion: z.literal(GRAPH_FORMAT_VERSION),
    tenant: TenantId,
    capabilities: z.array(Capability),
  })
  .superRefine((graph, ctx) => {
    const seen = new Set<string>();
    graph.capabilities.forEach((capability, index) => {
      if (seen.has(capability.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate capability id "${capability.id}"`,
          path: ["capabilities", index, "id"],
        });
      }
      seen.add(capability.id);
    });
  });

export type CapabilityId = z.infer<typeof CapabilityId>;
export type SideEffect = z.infer<typeof SideEffect>;
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
export type Auth = z.infer<typeof Auth>;
export type OriginCredential = z.infer<typeof OriginCredential>;
export type SecretPlacement = z.infer<typeof SecretPlacement>;
export type Executor = z.infer<typeof Executor>;
export type Price = z.infer<typeof Price>;
export type Provenance = z.infer<typeof Provenance>;
export type Capability = z.infer<typeof Capability>;
export type Graph = z.infer<typeof Graph>;
