// SPDX-License-Identifier: Apache-2.0
// How an http capability's arguments become a request to the tenant's origin, and how the
// answer is read. The edge executor and the contract tests both call these, and the
// OpenAPI emitter describes what they do, so a contract test calls exactly the URL an agent
// would, with the credential in the same place, under the same limits.

import type { Executor, SecretPlacement } from "./schema.ts";

/** How long the origin gets to answer when a capability sets no `timeoutMs`. */
export const DEFAULT_ORIGIN_TIMEOUT_MS = 10_000;
/** The most of an origin's response that is ever read. */
export const MAX_ORIGIN_RESPONSE_BYTES = 1024 * 1024;

/** Variable names in a path template, in order. */
export function pathVariables(path: string): string[] {
  return Array.from(path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g), (m) => m[1] as string);
}

/**
 * Substitute `{var}` path segments from arguments. Values that would change the path's
 * shape are refused: empty, `.`, `..`, or containing `/` or `\\`, which some origins decode
 * from %2F and %5C before routing. So are values that are not scalars or not valid Unicode.
 * Shared by the edge executor and contract tests, so both call exactly the same URL.
 */
export function fillPath(template: string, args: Record<string, unknown>): string | Error {
  let failure: Error | undefined;
  const path = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = args[name];
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      failure ??= new Error(`argument "${name}" must be a string, finite number or boolean`);
      return "";
    }
    const text = String(value);
    if (
      text === "" ||
      text === "." ||
      text === ".." ||
      /[/\\]/.test(text) ||
      !text.isWellFormed()
    ) {
      failure ??= new Error(`argument "${name}" is not a valid path segment`);
      return "";
    }
    return encodeURIComponent(text);
  });
  return failure ?? path;
}

/** Methods whose inputs travel in a JSON body; the others send them in the query string. */
export const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function hasNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasNonFinite);
}

/** A capability's arguments laid out as an origin request. */
export interface OriginRequest {
  /** Origin-relative path, variables filled in. */
  path: string;
  /** Query parameters in order; an array of scalars repeats its name. */
  query: [string, string][];
  /** The JSON body, for POST, PUT and PATCH. */
  body?: Record<string, unknown>;
}

/**
 * How an http capability's arguments become a request: path variables fill the path; for
 * POST, PUT and PATCH the other inputs form the JSON body, except the ones the executor
 * lists under `query`; for other methods they all go in the query string. There, scalars
 * and arrays of scalars are sent as `name=value` (repeated for an array), anything else as
 * one JSON-encoded value. Shared by the edge executor and contract tests, and described by
 * the OpenAPI emitter, so all three agree.
 */
export function originRequest(
  executor: Extract<Executor, { kind: "http" }>,
  args: Record<string, unknown>,
): OriginRequest | Error {
  if (hasNonFinite(args)) return new Error("arguments must not contain non-finite numbers");
  const path = fillPath(executor.path, args);
  if (path instanceof Error) return path;
  const pathNames = new Set(pathVariables(executor.path));
  const inQuery = new Set(executor.query ?? []);
  const hasBody = BODY_METHODS.has(executor.method);
  const query: [string, string][] = [];
  const body: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (pathNames.has(name) || value === undefined) continue;
    if (hasBody && !inQuery.has(name)) {
      body[name] = value;
    } else if (Array.isArray(value) && value.every(isScalar)) {
      for (const item of value) query.push([name, String(item)]);
    } else if (value !== null) {
      query.push([name, isScalar(value) ? String(value) : JSON.stringify(value)]);
    }
  }
  return { path, query, ...(hasBody ? { body } : {}) };
}

/** Base64 of the UTF-8 bytes of `text` (RFC 7617 user-pass). */
export function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Put a tenant secret where the origin expects it. Applied after the arguments, so an
 * argument can never replace it. Shared by the edge executor and contract tests.
 */
export function placeSecret(
  placement: SecretPlacement | undefined,
  secret: string,
  headers: Headers,
  url: URL,
): void {
  const where = placement ?? { in: "authorization", scheme: "bearer" };
  if (where.in === "authorization") {
    headers.set(
      "Authorization",
      where.scheme === "basic" ? `Basic ${base64Utf8(secret)}` : `Bearer ${secret}`,
    );
  } else if (where.in === "header") {
    headers.set(where.name, secret);
  } else {
    url.searchParams.set(where.name, secret);
  }
}

/** The response body as text, or an Error once it passes `maxBytes` (the rest is not read). */
export async function readLimited(
  response: Response,
  maxBytes = MAX_ORIGIN_RESPONSE_BYTES,
): Promise<string | Error> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return new Error(`the response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
