// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyLockfile,
  capabilityDigest,
  emittableCapabilities,
  emptyLockfile,
  type Graph,
  parseGraph,
  parseLockfile,
  recordDecision,
  serializeLockfile,
} from "../src/index.ts";

const fixture = (): Graph =>
  parseGraph(JSON.parse(readFileSync(new URL("./fixtures/graph.json", import.meta.url), "utf8")));
const pending = (): Graph => ({
  ...fixture(),
  capabilities: fixture().capabilities.map((c) => ({ ...c, approval: "pending" as const })),
});
const at = new Date("2026-10-30T12:00:00Z");

async function approveAll(graph: Graph) {
  let lock = emptyLockfile(graph.tenant);
  for (const c of graph.capabilities)
    lock = await recordDecision(lock, c, "approved", "owner@acme.test", at);
  return lock;
}

describe("capability digest", () => {
  it("ignores the approval field", async () => {
    const [c] = fixture().capabilities;
    if (!c) throw new Error("empty fixture");
    expect(await capabilityDigest({ ...c, approval: "approved" })).toBe(
      await capabilityDigest({ ...c, approval: "pending" }),
    );
    expect(await capabilityDigest(c)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("lockfile", () => {
  it("approves exactly the reviewed capabilities", async () => {
    const graph = pending();
    const [first] = graph.capabilities;
    if (!first) throw new Error("empty fixture");
    const lock = await recordDecision(
      emptyLockfile("acme"),
      first,
      "approved",
      "owner@acme.test",
      at,
    );
    expect((await emittableCapabilities(graph, lock)).map((c) => c.id)).toEqual([first.id]);
  });

  it("drops an approval when the capability changes after review", async () => {
    const graph = pending();
    const lock = await approveAll(graph);
    const changed: Graph = {
      ...graph,
      capabilities: graph.capabilities.map((c) =>
        c.id === "cancel_subscription"
          ? { ...c, description: `${c.description} Also deletes data.` }
          : c,
      ),
    };
    const applied = await applyLockfile(changed, lock);
    const byId = new Map(applied.capabilities.map((c) => [c.id, c.approval]));
    expect(byId.get("cancel_subscription")).toBe("pending");
    expect(byId.get("search_docs")).toBe("approved");
  });

  it("keeps approvals when only compiler metadata changes", async () => {
    const graph = pending();
    const lock = await approveAll(graph);
    const recompiled: Graph = {
      ...graph,
      capabilities: graph.capabilities.map((c) => ({
        ...c,
        confidence: c.confidence / 2,
        provenance: { source: "manual" as const },
      })),
    };
    const applied = await applyLockfile(recompiled, lock);
    expect(applied.capabilities.every((c) => c.approval === "approved")).toBe(true);
  });

  it("drops an approval when behaviour changes, e.g. the executor path or auth", async () => {
    const graph = pending();
    const lock = await approveAll(graph);
    const changed: Graph = {
      ...graph,
      capabilities: graph.capabilities.map((c) =>
        c.id === "get_usage_report" ? { ...c, auth: { kind: "none" as const } } : c,
      ),
    };
    const applied = await applyLockfile(changed, lock);
    expect(applied.capabilities.find((c) => c.id === "get_usage_report")?.approval).toBe("pending");
  });

  it("keeps rejections and never emits them", async () => {
    const graph = pending();
    const [first] = graph.capabilities;
    if (!first) throw new Error("empty fixture");
    const lock = await recordDecision(
      emptyLockfile("acme"),
      first,
      "rejected",
      "owner@acme.test",
      at,
    );
    const applied = await applyLockfile(graph, lock);
    expect(applied.capabilities.find((c) => c.id === first.id)?.approval).toBe("rejected");
    expect(await emittableCapabilities(graph, lock)).toEqual([]);
  });

  it("replaces an earlier decision for the same capability", async () => {
    const [first] = pending().capabilities;
    if (!first) throw new Error("empty fixture");
    let lock = await recordDecision(emptyLockfile("acme"), first, "approved", "a@acme.test", at);
    lock = await recordDecision(lock, first, "rejected", "b@acme.test", at);
    expect(lock.capabilities).toHaveLength(1);
    expect(lock.capabilities[0]?.decision).toBe("rejected");
  });

  it("refuses a lockfile for another tenant", async () => {
    const lock = await approveAll(pending());
    await expect(applyLockfile({ ...pending(), tenant: "other" }, lock)).rejects.toThrow(/tenant/);
  });

  it("normalises entry order, so equivalent lockfiles serialise identically", async () => {
    const lock = await approveAll(pending());
    const shuffled = { ...lock, capabilities: [...lock.capabilities].reverse() };
    expect(serializeLockfile(parseLockfile(shuffled))).toBe(serializeLockfile(lock));
  });

  it("round-trips through JSON", async () => {
    const lock = await approveAll(pending());
    const text = serializeLockfile(lock);
    expect(parseLockfile(JSON.parse(text))).toEqual(lock);
    expect(serializeLockfile(parseLockfile(JSON.parse(text)))).toBe(text);
  });
});
