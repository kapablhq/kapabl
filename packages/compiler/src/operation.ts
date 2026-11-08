// SPDX-License-Identifier: Apache-2.0
// One intermediate shape for an HTTP operation, whether it came from an OpenAPI document
// or was inferred from a HAR capture, and the single place that turns it into a graph
// capability (AGENTS.md H2): side effect, auth, credential, id, confidence, provenance.
// Everything it produces is "pending" until the owner reviews it (H3).

import { Capability, type JsonSchemaNode, type SecretPlacement } from "@kapabl/graph";
import { isCredentialName } from "./scrub.ts";

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Param {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
  description?: string;
}

export interface Operation {
  method: Method;
  /** Origin-relative path template with `{name}` variables, base path included. */
  path: string;
  pathParams: Param[];
  query: Param[];
  /** JSON object request body schema (POST, PUT, PATCH). */
  body?: Record<string, unknown>;
  /** JSON response schema of the first success response. */
  output?: Record<string, unknown>;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  /** Short string values seen in captured request bodies (`"cancelled"`, `"users.delete"`). */
  hints?: string[];
  /** How the source says callers authenticate. */
  security:
    | { kind: "none" }
    | { kind: "user"; scopes: string[] }
    | { kind: "api-key"; scheme: string; placement?: SecretPlacement };
}

export type Source =
  | { kind: "openapi"; document: string }
  | { kind: "har"; capture: string; samples: number };

export interface Skipped {
  method: string;
  path: string;
  reason: string;
}

/**
 * Words that make an action destructive: it deletes, cancels, refunds, moves money, or
 * cannot be taken back. Stems match every form (`cancellations`, `deletion`, `revocation`).
 * Wrong guesses err this way on purpose: the owner downgrades one in review.
 */
const DESTRUCTIVE_WORD =
  /^(?:delet\w*|remov(?:e|es|ed|al|als)|destr(?:oy|oys|oyed|uction)|eras(?:e|es|ed|ure)|cancel\w*|refund\w*|void(?:s|ed)?|revo(?:ke|kes|ked|cation|cations)|terminat\w*|purg(?:e|es|ed)|wip(?:e|es|ed)|deactivat\w*|unsubscrib\w*|pay(?:s|ment|ments|out|outs|roll|now)?|charg(?:e|es|ed)|captur(?:e|es|ed)|checkouts?|purchas\w*|transfer\w*|withdraw\w*|trash\w*|archiv\w*|suspen(?:d|ds|ded|sion)|ban(?:s|ned)?|disabl\w*|disburs\w*|remit\w*|debit\w*|settl(?:e|es|ed|ement|ements)|unlink\w*|detach\w*|uninstall\w*|send|sends|rotat(?:e|es|ed|ion)|revers(?:e|es|ed|al)|rollback|reset|resets)$/;

/**
 * On GET, only a verb that cannot be a noun, and only as the last path word or the first
 * operationId word (`GET /items/{id}/delete`, `cancelOrder`): `/checkout/sessions`,
 * `/archive` and `/transfers/{id}` are reads.
 */
const ITEM_ACTION =
  /^(?:trash|close|archive|disable|ban|send|resend|capture|checkout|transfer|charge|settle|reverse|rotate|reset|refund|pay|payout)$/;
const READ_VERB =
  /^(?:get|list|search|find|fetch|read|show|retrieve|describe|count|query|lookup|check|view|preview|export|download)$/;
const DESTRUCTIVE_VERB =
  /^(?:delete|remove|destroy|erase|cancel|refund|void|revoke|terminate|purge|wipe|deactivate|unsubscribe|pay|paynow|withdraw|suspend|unlink|uninstall)$/;

/** `POST /payment_intents/{id}/capture`, `payNow` → [payment, intents, capture, pay, now]. */
function actionWords(text: string): string[] {
  return text
    .replace(/\{[^}]*\}/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * H2: DELETE and anything named like delete/cancel/refund/pay/transfer is destructive,
 * including a GET whose path or id is such a verb; other GETs are read; the rest is
 * write. Names are compared word by word, so `payment_intents` and `pay_now` count but
 * `payload` and `avoid` do not. Values seen in request bodies count too: `PATCH
 * /subscriptions/{id} {"status": "cancelled"}` cancels.
 */
export function sideEffectOf(op: Operation): Capability["sideEffect"] {
  if (op.method === "DELETE") return "destructive";
  if (op.method === "GET" || op.method === "HEAD") {
    // `/cancel-order`, `/orders/1/delete.json`: any word of the last literal segment.
    const last = op.path
      .split("/")
      .filter((s) => s && !s.startsWith("{"))
      .at(-1)
      ?.replace(/\.[a-z0-9]+$/i, "");
    const named = actionWords(last ?? "");
    // An action on one item (`/files/{id}/trash`, `/accounts/{id}/close`) even when the
    // word alone could name a list (`GET /trash`).
    const segments = op.path.split("/").filter(Boolean);
    const onItem = segments.length >= 2 && segments.at(-2)?.startsWith("{") === true;
    if (onItem && named.some((w) => ITEM_ACTION.test(w))) return "destructive";
    // Every word of an operationId, unless it starts as a read (`getRefundStatus`). Its
    // first word is the verb, so any destructive form counts there (`transferFunds`).
    const id = op.operationId ? actionWords(op.operationId) : [];
    if (DESTRUCTIVE_WORD.test(id[0] ?? "")) return "destructive";
    if (!READ_VERB.test(id[0] ?? "")) named.push(...id);
    return named.some((w) => DESTRUCTIVE_VERB.test(w)) ? "destructive" : "read";
  }
  const words = actionWords(
    [op.path, op.operationId, op.summary, ...(op.hints ?? [])].filter(Boolean).join(" "),
  );
  // Creating an order is a purchase (A4); updating one is not.
  const last = op.path
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .at(-1);
  const destructive =
    words.some((w) => DESTRUCTIVE_WORD.test(w)) ||
    (op.method === "POST" && /^orders?$/i.test(last ?? "")) ||
    (words.includes("close") && (words.includes("account") || words.includes("accounts")));
  return destructive ? "destructive" : "write";
}

export function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

const VERB: Record<Method, string> = {
  GET: "get",
  HEAD: "head",
  POST: "create",
  PUT: "replace",
  PATCH: "update",
  DELETE: "delete",
};

/** Literal path segments, minus version prefixes like `api` and `v1`. */
function nouns(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s && !s.startsWith("{") && !/^(?:api|v\d+)$/i.test(s))
    .map(snake)
    .filter(Boolean);
}

/** `invoices` → `invoice`, `categories` → `category`; leaves `status` and `address` alone. */
export function singular(noun: string): string {
  if (/ies$/.test(noun)) return noun.replace(/ies$/, "y");
  if (/(?:ss|us|is)$/.test(noun)) return noun;
  return noun.replace(/s$/, "");
}

/**
 * A stable snake_case id: the operationId if there is one, else verb + path nouns.
 * GET /invoices → list_invoices, GET /invoices/{id} → get_invoice,
 * POST /invoices/{id}/refund → refund_invoice, DELETE /webhooks/{id} → delete_webhook.
 */
export function idFor(op: Operation): string {
  let base = op.operationId ? snake(op.operationId) : "";
  if (!base) {
    const parts = nouns(op.path);
    const segments = op.path.split("/").filter(Boolean);
    const last = segments.at(-1) ?? "";
    const onItem = last.startsWith("{");
    if (op.method === "POST" && !onItem && segments.at(-2)?.startsWith("{") && parts.length >= 2) {
      const action = parts.at(-1) as string;
      parts.splice(-2, 2, action, singular(parts.at(-2) as string));
      base = parts.slice(-2).concat(parts.slice(0, -2)).join("_");
    } else {
      if (onItem && parts.length > 0) parts.push(singular(parts.pop() as string));
      const verb = op.method === "GET" && !onItem && parts.length > 0 ? "list" : VERB[op.method];
      base = [verb, ...parts].join("_");
    }
  }
  if (!/^[a-z]/.test(base)) base = `op_${base}`;
  if (base === "search" || base === "execute") base = `${base}_action`;
  return base.slice(0, 64).replace(/_+$/, "");
}

function humanize(id: string): string {
  const text = id.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Scope for a user-authenticated action with no declared scopes: `<resource>:read|write`. */
function derivedScope(op: Operation, sideEffect: Capability["sideEffect"]): string {
  const resource = op.tags?.[0] ? snake(op.tags[0]) : (nouns(op.path)[0] ?? "account");
  return `${resource}:${sideEffect === "read" ? "read" : "write"}`;
}

/** The Worker secret holding the tenant's key: the edge only resolves TENANT_* names. */
function secretRef(scheme: string): string {
  return `TENANT_${snake(scheme).toUpperCase() || "API_KEY"}`.slice(0, 64).replace(/_+$/, "");
}

const BODY_METHODS = new Set<Method>(["POST", "PUT", "PATCH"]);

interface Inputs {
  schema: Record<string, unknown>;
  /** For body methods: the inputs sent in the query string instead of the body. */
  query: string[];
}

function inputSchema(op: Operation): Inputs | string {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  const add = (p: Param) => {
    if (properties[p.name] !== undefined) return `input "${p.name}" appears twice`;
    properties[p.name] = p.description ? { ...p.schema, description: p.description } : p.schema;
    if (p.required) required.push(p.name);
    return undefined;
  };
  for (const p of op.pathParams) {
    const clash = add({ ...p, required: true });
    if (clash) return clash;
  }
  const hasBody = BODY_METHODS.has(op.method);
  const body: Param[] = hasBody
    ? Object.entries((op.body?.properties ?? {}) as Record<string, Record<string, unknown>>).map(
        ([name, schema]) => ({
          name,
          schema,
          // PATCH is a partial update: nothing in its body is required.
          required: op.method !== "PATCH" && ((op.body?.required ?? []) as string[]).includes(name),
        }),
      )
    : [];
  const query: string[] = [];
  for (const [p, inQuery] of [
    ...op.query.map((p) => [p, true] as const),
    ...body.map((p) => [p, false] as const),
  ]) {
    // Inputs an agent must never be asked for: the server or the session supplies them.
    if (isCredentialName(p.name)) {
      // Nothing fills a dropped field later, so a tool that needs one could never succeed.
      // A CSRF token is the exception when a signed-in token, not a cookie, makes the call.
      const sessionOnly = /csrf|xsrf/i.test(p.name) && op.security.kind !== "none";
      if (p.required && !sessionOnly) return `needs "${p.name}", which agents must never supply`;
      continue;
    }
    const clash = add(p);
    if (clash) return clash;
    if (inQuery && hasBody) query.push(p.name);
  }
  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    query,
  };
}

export interface BuildOptions {
  source: Source;
  /** The API's origin: where calls go, and the audience of exchanged tokens. */
  apiOrigin: string;
  /** H2: how sure the compiler is, 0 to 1. */
  confidence: number;
}

/** Build a pending capability, or the reason it cannot be one. */
export function toCapability(op: Operation, options: BuildOptions): Capability | Skipped {
  const skip = (reason: string): Skipped => ({ method: op.method, path: op.path, reason });
  if (op.method === "HEAD") return skip("HEAD requests are not useful as actions");
  const inputs = inputSchema(op);
  if (typeof inputs === "string") return skip(inputs);

  const id = idFor(op);
  const sideEffect = sideEffectOf(op);
  // Anonymous agents must never cancel, refund or delete (graph rule): those need a user.
  let scopes: string[] | undefined;
  if (op.security.kind === "user") {
    scopes = op.security.scopes.length > 0 ? op.security.scopes : [derivedScope(op, sideEffect)];
  } else if (sideEffect === "destructive") {
    scopes = [derivedScope(op, sideEffect)];
  }
  // The agent's token is never forwarded (A2): a user-authenticated API gets an exchanged
  // token for its own audience, an API-key API gets the tenant's stored key.
  const credential =
    op.security.kind === "api-key"
      ? {
          kind: "tenant-secret",
          secretRef: secretRef(op.security.scheme),
          ...(op.security.placement ? { placement: op.security.placement } : {}),
        }
      : op.security.kind === "user"
        ? { kind: "token-exchange", audience: options.apiOrigin }
        : { kind: "none" };

  const title = (op.summary?.trim() || humanize(id)).slice(0, 120);
  const description = (
    op.description?.trim() ||
    op.summary?.trim() ||
    `${op.method} ${op.path}`
  ).slice(0, 2000);
  const provenance: Capability["provenance"] =
    options.source.kind === "openapi"
      ? {
          source: "openapi",
          document: options.source.document,
          ...(op.operationId ? { operationId: op.operationId } : {}),
          method: op.method,
          path: op.path,
        }
      : {
          source: "har",
          capture: options.source.capture,
          method: op.method,
          path: op.path,
          samples: options.source.samples,
        };

  const candidate = {
    id,
    title,
    description,
    sideEffect,
    inputSchema: inputs.schema,
    ...(op.output && op.output.type === "object" ? { outputSchema: op.output } : {}),
    auth: scopes ? { kind: "oauth", scopes } : { kind: "none" },
    executor: {
      kind: "http",
      method: op.method,
      path: op.path,
      ...(inputs.query.length > 0 ? { query: inputs.query } : {}),
      credential,
    },
    provenance,
    confidence: Math.round(Math.min(1, Math.max(0, options.confidence)) * 100) / 100,
    approval: "pending",
  };
  const parsed = Capability.safeParse(candidate);
  if (!parsed.success) {
    return skip(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/**
 * Make ids unique within one compile: a second `get_invoice` becomes `get_invoice_2`, or
 * `get_invoice_3` when another operation is already called `get_invoice_2`.
 */
export function dedupeIds(capabilities: Capability[]): Capability[] {
  const taken = new Set(capabilities.map((c) => c.id));
  const used = new Set<string>();
  return capabilities.map((c) => {
    if (!used.has(c.id)) {
      used.add(c.id);
      return c;
    }
    for (let n = 2; ; n++) {
      const suffix = `_${n}`;
      const id = `${c.id.slice(0, 64 - suffix.length)}${suffix}`;
      if (taken.has(id) || used.has(id)) continue;
      used.add(id);
      return { ...c, id };
    }
  });
}
