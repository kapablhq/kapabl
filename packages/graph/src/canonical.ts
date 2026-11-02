// SPDX-License-Identifier: Apache-2.0
// Canonical JSON: object keys sorted, no undefined values, so the same graph
// always serialises to the same bytes and the same digest.

function sortKeys(value: unknown): unknown {
  // JSON.stringify writes Infinity, -Infinity and NaN all as null: refuse them, or two
  // different values would share one digest.
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`canonical JSON cannot represent the number ${value}`);
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    // Object.fromEntries defines own properties, so a JSON key named "__proto__"
    // survives instead of being swallowed as a prototype assignment.
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Sort comparator for anything with a string `id`, by UTF-16 code unit (locale-independent). */
export function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Compact canonical JSON, used for digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Human-readable canonical JSON, used for files on disk. Ends with a newline. */
export function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** `sha256:<hex>` of the UTF-8 bytes of `text`. Uses Web Crypto (Workers and Node 24). */
export async function sha256Text(text: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** `sha256:<hex>` of the canonical JSON of `value`. */
export function sha256Digest(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}
