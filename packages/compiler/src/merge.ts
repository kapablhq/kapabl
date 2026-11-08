// SPDX-License-Identifier: Apache-2.0
// Fold freshly compiled capabilities into the tenant's graph. A capability with the same
// id is replaced (the lockfile digest decides whether its approval still holds); every
// other capability, including hand-written ones, is kept as it was.

import {
  type Capability,
  canonicalJson,
  GRAPH_FORMAT_VERSION,
  type Graph,
  parseGraph,
} from "@kapabl/graph";

export interface MergeResult {
  graph: Graph;
  added: string[];
  updated: string[];
  unchanged: string[];
}

export function mergeCapabilities(
  existing: Graph | undefined,
  tenant: string,
  compiled: readonly Capability[],
): MergeResult {
  if (existing && existing.tenant !== tenant) {
    throw new Error(`graph is for tenant "${existing.tenant}", not "${tenant}"`);
  }
  const byId = new Map((existing?.capabilities ?? []).map((c) => [c.id, c]));
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const capability of compiled) {
    const previous = byId.get(capability.id);
    if (!previous) added.push(capability.id);
    else if (canonicalJson(previous) === canonicalJson(capability)) unchanged.push(capability.id);
    else updated.push(capability.id);
    byId.set(capability.id, capability);
  }
  const graph = parseGraph({
    formatVersion: GRAPH_FORMAT_VERSION,
    tenant,
    capabilities: [...byId.values()],
  });
  return { graph, added: added.sort(), updated: updated.sort(), unchanged: unchanged.sort() };
}
