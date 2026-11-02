// SPDX-License-Identifier: Apache-2.0

import { byId, prettyCanonicalJson, sha256Digest } from "./canonical.ts";
import { applyLockfile, type Lockfile } from "./lockfile.ts";
import { type Capability, Graph } from "./schema.ts";

/**
 * JSON that parses but does not survive downstream, refused up front so what was reviewed
 * is exactly what gets emitted:
 * - a key "__proto__": Zod, the MCP SDK and other consumers turn it into a prototype
 *   assignment and silently drop it;
 * - lone surrogates in keys or strings: schema validators throw on them (encodeURI), which
 *   would take the whole MCP endpoint down;
 * - numbers JSON cannot represent (1e400 parses to Infinity and serialises as null).
 */
function rejectUnsafeJson(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error(`${path}: the string is not valid Unicode`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: the number ${value} is not finite`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Object.hasOwn(value, "__proto__")) {
    throw new Error(`${path}: the key "__proto__" is not allowed`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (!key.isWellFormed()) throw new Error(`${path}: a key is not valid Unicode`);
    rejectUnsafeJson(child, `${path}/${key}`);
  }
}

/** Validate and normalise a graph: capabilities sorted by id, so tool order is deterministic. */
export function parseGraph(json: unknown): Graph {
  rejectUnsafeJson(json, "#");
  const graph = Graph.parse(json);
  return { ...graph, capabilities: [...graph.capabilities].sort(byId) };
}

/** Canonical on-disk form. `serializeGraph(parseGraph(JSON.parse(s))) === s` for any canonical `s`. */
export function serializeGraph(graph: Graph): string {
  return prettyCanonicalJson(parseGraph(graph));
}

/** Digest of the whole graph, for versioning and cache keys. */
export function graphDigest(graph: Graph): Promise<string> {
  return sha256Digest(parseGraph(graph));
}

/**
 * Capabilities that may be emitted to any agent surface. Approval comes only from the
 * lockfile, checked against each capability's digest; the graph's own `approval` field is
 * ignored, so editing graph.json can never put an unreviewed capability live.
 */
export async function emittableCapabilities(graph: Graph, lock: Lockfile): Promise<Capability[]> {
  const reviewed = await applyLockfile(parseGraph(graph), lock);
  return reviewed.capabilities.filter((c) => c.approval === "approved");
}
