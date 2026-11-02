// SPDX-License-Identifier: Apache-2.0
// HAR → pending capabilities. The capture is scrubbed first (H1); nothing below ever sees
// a credential. Requests are grouped by method and path template (id-like segments become
// `{noun_id}` variables), their JSON samples merged into schemas, and each group becomes
// one capability through the same builder the OpenAPI importer uses.

import { type Capability, sha256Text } from "@kapabl/graph";
import type { Entry } from "har-format";
import { inferParamSchema, inferSchema } from "./infer-schema.ts";
import {
  dedupeIds,
  type Method,
  type Operation,
  type Skipped,
  singular,
  toCapability,
} from "./operation.ts";
import { PLACEHOLDER, type ScrubReport, scrubHar, withTypes } from "./scrub.ts";

export interface HarCompileOptions {
  /** The API origin to compile, e.g. https://app.example.com. Default: the busiest JSON host. */
  apiOrigin?: string;
}

export interface CompileResult {
  capabilities: Capability[];
  skipped: Skipped[];
  apiOrigin: string;
}

export interface HarCompileResult extends CompileResult {
  scrub: ScrubReport;
  /**
   * Arguments from one successful captured call per capability, for contract tests (H4).
   * Scrubbed values only, and anything redacted is left out. They stay in the owner's
   * contracts file and never appear in a tool schema an agent sees.
   */
  examples: Record<string, Record<string, unknown>>;
  /** sha256 of the scrubbed capture: the provenance every capability points back to. */
  capture: string;
  /** Origins the capture made JSON API calls to, busiest first: the choices for apiOrigin. */
  origins: string[];
  /**
   * HTML pages the capture opened, as `origin` + path template, sorted: the screens a person
   * used. What happened only on them, with no JSON call captured, cannot become a tool from
   * this capture. Sign-in pages are left out, and ids in paths are templated.
   */
  pages: string[];
}

const METHODS = new Set<Method>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const STATIC = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|html?)$/i;
/** Sign-in plumbing is never an action an agent should call. */
const AUTH_PATH =
  /\/(?:log[-_]?in|log[-_]?out|sign[-_]?in|sign[-_]?out|sign[-_]?up|oauth2?|authorize|sso|saml|mfa|2fa|magic[-_]?link)(?:\/|$)/i;
/**
 * Words that are sign-in only at the top of the path (`/auth/...`, `/api/v1/verify`) or
 * under an account word (`/email/verify`): `/payments/verify` is a business action.
 */
const AUTH_LEADING =
  /^\/(?:api\/)?(?:v\d+\/)?(?:auth|callback|verify|register|token|session|password)(?:\/|$)/i;
const AUTH_NESTED =
  /\/(?:auth|oauth2?|users?|accounts?|email|phone|identity|me)\/(?:auth|callback|verify|register|token|session|password)(?:\/|$)/i;

function isAuthPath(path: string): boolean {
  return AUTH_PATH.test(path) || AUTH_LEADING.test(path) || AUTH_NESTED.test(path);
}
/** One URL carrying many actions: a capture cannot tell them apart. */
const MULTIPLEXED_PATH = /\/(?:graphql|gql|rpc|jsonrpc|batch)$/i;

function isJson(mimeType: string | undefined): boolean {
  return /\bjson\b/i.test(mimeType ?? "");
}

/**
 * Path segments that are identifiers, not names. A prefixed id (`inv_8f3a2b9c`) needs a
 * digit or a long mixed-case tail, so `bulk_delete` and `payment_intents` stay words.
 * A scrubber placeholder (`[email]`) stood for a value, so it is one too.
 */
function isIdSegment(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[0-9a-f]{12,}$/i.test(segment) ||
    /^[A-Za-z]{2,8}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}$/.test(segment) ||
    /^[A-Za-z]{2,8}_(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{12,}$/.test(segment) ||
    /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9-]{16,}$/.test(segment) ||
    /^\[[a-z-]+\]$/.test(segment)
  );
}

/** `/api/v1/invoices/inv_8f3a/refund` → `/api/v1/invoices/{invoice_id}/refund`. */
export function templatePath(path: string): { template: string; names: string[] } {
  const names: string[] = [];
  const segments = path.split("/").map((segment, i, all) => {
    if (!isIdSegment(segment)) return segment;
    const previous = all[i - 1] ?? "";
    let base =
      previous && !isIdSegment(previous)
        ? `${singular(previous.toLowerCase().replace(/[^a-z0-9]+/g, "_"))}_id`
        : "id";
    if (!/^[a-z_]/.test(base)) base = `id_${base}`;
    let name = base;
    for (let n = 2; names.includes(name); n++) name = `${base}_${n}`;
    names.push(name);
    return `{${name}}`;
  });
  return { template: segments.join("/"), names };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface Group {
  method: Method;
  template: string;
  names: string[];
  entries: Entry[];
  credentialed: boolean;
}

/** Origins with JSON responses, busiest first. */
function jsonOrigins(entries: Entry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!isJson(e.response.content.mimeType)) continue;
    const origin = new URL(e.request.url).origin;
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([o]) => o);
}

/** Keys whose value says what a write does: `{"status": "cancelled"}`, `{"action": "refund"}`. */
const ACTION_KEY = /^(?:status|state|action|op|operation|type|event|intent|command)$/i;

/**
 * Short values (up to three words) under action keys, and the names of flags set to true,
 * anywhere in a body. Free text (`{"note": "send it later"}`) and values under other keys
 * (`{"filter": "archived"}`) name nothing.
 */
function actionValues(value: unknown, key?: string): string[] {
  if (typeof value === "string")
    return key &&
      ACTION_KEY.test(key) &&
      /^[a-z][a-z0-9_.:-]*(?: [a-z0-9_.:-]+){0,2}$/i.test(value) &&
      value.length <= 40
      ? [value]
      : [];
  // A flag set to true says what the write does: `{"deleted": true}`, `{"cancel_at_period_end": true}`.
  if (value === true) return key ? [key] : [];
  if (Array.isArray(value)) return value.flatMap((v) => actionValues(v, key));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => actionValues(v, k));
  return [];
}

function toOperation(group: Group): Operation | string {
  const ok = group.entries.filter((e) => e.response.status >= 200 && e.response.status < 300);
  if (ok.length === 0) return "no successful response was captured";

  const query = new Map<string, string[]>();
  for (const e of ok) {
    for (const [name, value] of new URL(e.request.url).searchParams) {
      query.set(name, [...(query.get(name) ?? []), value]);
    }
  }
  const queryParams = [...query.keys()].sort().map((name) => ({
    name,
    schema: inferParamSchema(query.get(name) ?? []),
    // A capture shows what one user happened to filter by, not what the API demands.
    required: false,
  }));

  let body: Record<string, unknown> | undefined;
  let hints: string[] = [];
  if (group.method === "POST" || group.method === "PUT" || group.method === "PATCH") {
    const withBody = ok.filter((e) => e.request.postData?.text);
    if (withBody.some((e) => !isJson(e.request.postData?.mimeType))) {
      return "the request body is not JSON (form bodies are not supported yet)";
    }
    // Placeholders for redacted numbers, objects and lists keep their original types.
    const samples = withBody.map((e) => withTypes(parseJson(e.request.postData?.text)));
    if (samples.some((s) => s === null || typeof s !== "object" || Array.isArray(s))) {
      return "the request body is not a JSON object";
    }
    body = samples.length > 0 ? inferSchema(samples) : { type: "object", properties: {} };
    hints = samples.flatMap((s) => actionValues(s));
    // One sample cannot tell a required field from one the user happened to fill in.
    if (samples.length < 2) delete body.required;
  }

  const outputs = ok
    .filter((e) => isJson(e.response.content.mimeType))
    .map((e) => parseJson(e.response.content.text))
    .filter((v) => v !== undefined)
    .map(withTypes);

  return {
    method: group.method,
    path: group.template,
    pathParams: group.names.map((name) => ({ name, schema: { type: "string" }, required: true })),
    query: queryParams,
    ...(body ? { body } : {}),
    ...(outputs.length > 0 ? { output: inferSchema(outputs) } : {}),
    ...(hints.length > 0 ? { hints: [...new Set(hints)].sort() } : {}),
    security: group.credentialed ? { kind: "user", scopes: [] } : { kind: "none" },
  };
}

function exampleArgs(group: Group, capability: Capability): Record<string, unknown> {
  const entry = group.entries.find((e) => e.response.status >= 200 && e.response.status < 300);
  if (!entry) return {};
  const url = new URL(entry.request.url);
  const args: Record<string, unknown> = {};
  const actual = url.pathname.split("/");
  group.template.split("/").forEach((segment, i) => {
    const name = /^\{(\w+)\}$/.exec(segment)?.[1];
    if (!name || actual[i] === undefined) return;
    try {
      args[name] = decodeURIComponent(actual[i]);
    } catch {
      // A malformed escape is no example.
    }
  });
  for (const [name, value] of url.searchParams) args[name] ??= value;
  const body = parseJson(entry.request.postData?.text);
  if (body && typeof body === "object" && !Array.isArray(body)) Object.assign(args, body);
  const allowed = (capability.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
  return Object.fromEntries(
    Object.entries(args)
      .filter(
        ([name, value]) => Object.hasOwn(allowed, name) && !PLACEHOLDER.test(JSON.stringify(value)),
      )
      // Query values are strings on the wire; the schema may say integer or boolean.
      .map(([name, value]) => [
        name,
        typeof value === "string" ? coerce(value, allowed[name]?.type) : value,
      ]),
  );
}

function coerce(value: string, type: unknown): unknown {
  if (
    (type === "integer" || type === "number") &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/** H2 for inferred actions: more samples, more confidence; never certainty. */
function confidenceFor(samples: number): number {
  return Math.min(0.8, 0.4 + 0.1 * samples);
}

export async function compileHar(
  input: unknown,
  options: HarCompileOptions = {},
): Promise<HarCompileResult> {
  const { har, report } = scrubHar(input);
  const capture = await sha256Text(JSON.stringify(har));
  const credentialed = new Set(report.credentialed);
  const entries = har.log.entries;
  const origins = jsonOrigins(entries);
  const apiOrigin = options.apiOrigin ? new URL(options.apiOrigin).origin : origins[0];
  if (!apiOrigin) throw new Error("no JSON API requests found in the capture");

  const skipped: Skipped[] = [];
  const groups = new Map<string, Group>();
  const pages = new Set<string>();
  entries.forEach((entry, index) => {
    const url = new URL(entry.request.url);
    const method = entry.request.method.toUpperCase() as Method;
    const status = entry.response.status;
    if (
      method === "GET" &&
      status >= 200 &&
      status < 300 &&
      /^text\/html\b/i.test(entry.response.content.mimeType ?? "") &&
      !isAuthPath(url.pathname)
    )
      pages.add(`${url.origin}${templatePath(url.pathname).template}`);
    if (url.origin !== apiOrigin || !METHODS.has(method) || STATIC.test(url.pathname)) return;
    const content = entry.response.content;
    const json = isJson(content.mimeType);
    const ok = status >= 200 && status < 300;
    const empty = !content.text && (content.size ?? 0) <= 0;
    if (!json && !(ok && (status === 204 || empty))) {
      if (method === "GET" || !ok) return; // pages, images, downloads, redirects
      skipped.push({
        method,
        path: templatePath(url.pathname).template,
        reason: `the response is ${content.mimeType || "not JSON"}, not JSON`,
      });
      return;
    }
    const { template, names } = templatePath(url.pathname);
    if (MULTIPLEXED_PATH.test(url.pathname)) {
      skipped.push({
        method,
        path: template,
        reason: "one URL carries many actions (GraphQL or RPC); import its schema instead",
      });
      return;
    }
    if (isAuthPath(url.pathname)) {
      // The template, not the path: a sign-in path can carry a token.
      skipped.push({ method, path: template, reason: "sign-in endpoints are never exposed" });
      return;
    }
    const key = `${method} ${template}`;
    const group = groups.get(key) ?? { method, template, names, entries: [], credentialed: false };
    group.entries.push(entry);
    group.credentialed ||= credentialed.has(index);
    groups.set(key, group);
  });

  const capabilities: Capability[] = [];
  const sources: Group[] = [];
  for (const group of [...groups.values()].sort((a, b) =>
    a.template === b.template ? (a.method < b.method ? -1 : 1) : a.template < b.template ? -1 : 1,
  )) {
    const op = toOperation(group);
    if (typeof op === "string") {
      skipped.push({ method: group.method, path: group.template, reason: op });
      continue;
    }
    const built = toCapability(op, {
      source: { kind: "har", capture, samples: group.entries.length },
      apiOrigin,
      confidence: confidenceFor(group.entries.length),
    });
    if ("reason" in built) skipped.push(built);
    else {
      capabilities.push(built);
      sources.push(group);
    }
  }
  const unique = dedupeIds(capabilities);
  const examples = Object.fromEntries(
    unique.map((c, i) => [c.id, exampleArgs(sources[i] as Group, c)]),
  );
  return {
    capabilities: unique,
    skipped,
    apiOrigin,
    scrub: report,
    capture,
    examples,
    origins,
    pages: [...pages].sort(),
  };
}
