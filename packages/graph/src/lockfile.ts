// SPDX-License-Identifier: Apache-2.0
// capabilities.lock.json: the owner's review decisions, written by `kapabl review`.
// Each decision is pinned to a digest of the capability as reviewed. If the compiler
// later changes a capability, its digest changes and it falls back to "pending", so an
// approval never carries over to something nobody looked at.

import { z } from "zod";
import { byId, prettyCanonicalJson, sha256Digest } from "./canonical.ts";
import { type Capability, CapabilityId, type Graph, Sha256Digest, TenantId } from "./schema.ts";

export const LOCKFILE_FORMAT_VERSION = 1;

export const LockEntry = z.strictObject({
  id: CapabilityId,
  digest: Sha256Digest.meta({
    description: "Digest of the capability as reviewed, without its approval field.",
  }),
  decision: z.enum(["approved", "rejected"]),
  reviewedBy: z.string().min(1),
  reviewedAt: z.iso.datetime({ offset: true }),
});

export const Lockfile = z
  .strictObject({
    lockfileVersion: z.literal(LOCKFILE_FORMAT_VERSION),
    tenant: TenantId,
    capabilities: z.array(LockEntry),
  })
  .superRefine((lock, ctx) => {
    const seen = new Set<string>();
    lock.capabilities.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate lock entry "${entry.id}"`,
          path: ["capabilities", index, "id"],
        });
      }
      seen.add(entry.id);
    });
  });

export type LockEntry = z.infer<typeof LockEntry>;
export type Lockfile = z.infer<typeof Lockfile>;

/**
 * Digest of what a reviewer approves: everything agents see or that changes what runs.
 * Compiler metadata (provenance, confidence) and the approval status itself are left out,
 * so re-compiling from a fresh capture does not throw away unchanged approvals.
 */
export function capabilityDigest(capability: Capability): Promise<string> {
  const {
    approval: _approval,
    provenance: _provenance,
    confidence: _confidence,
    ...reviewed
  } = capability;
  return sha256Digest(reviewed);
}

export function emptyLockfile(tenant: string): Lockfile {
  return { lockfileVersion: LOCKFILE_FORMAT_VERSION, tenant, capabilities: [] };
}

/** Record (or replace) a review decision for `capability`. Returns a new lockfile. */
export async function recordDecision(
  lock: Lockfile,
  capability: Capability,
  decision: LockEntry["decision"],
  reviewedBy: string,
  reviewedAt: Date,
): Promise<Lockfile> {
  const entry: LockEntry = {
    id: capability.id,
    digest: await capabilityDigest(capability),
    decision,
    reviewedBy,
    reviewedAt: reviewedAt.toISOString(),
  };
  const capabilities = lock.capabilities.filter((e) => e.id !== capability.id).concat(entry);
  return parseLockfile({ ...lock, capabilities });
}

/**
 * Set each capability's approval from the lockfile. A decision applies only while
 * the capability still matches the digest that was reviewed; otherwise it is pending.
 */
export async function applyLockfile(graph: Graph, lock: Lockfile): Promise<Graph> {
  if (graph.tenant !== lock.tenant) {
    throw new Error(`lockfile is for tenant "${lock.tenant}", graph is for "${graph.tenant}"`);
  }
  const entries = new Map(lock.capabilities.map((e) => [e.id, e]));
  const capabilities = await Promise.all(
    graph.capabilities.map(async (capability) => {
      const entry = entries.get(capability.id);
      const matches = entry !== undefined && entry.digest === (await capabilityDigest(capability));
      return { ...capability, approval: matches ? entry.decision : "pending" } as Capability;
    }),
  );
  return { ...graph, capabilities };
}

/** Validate and normalize a lockfile: entries sorted by id, like the graph. */
export function parseLockfile(json: unknown): Lockfile {
  const lock = Lockfile.parse(json);
  return { ...lock, capabilities: [...lock.capabilities].sort(byId) };
}

export function serializeLockfile(lock: Lockfile): string {
  return prettyCanonicalJson(parseLockfile(lock));
}
