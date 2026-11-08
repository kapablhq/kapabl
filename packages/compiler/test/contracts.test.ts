// SPDX-License-Identifier: Apache-2.0
// AGENTS.md H4: contract tests check status and response schema against the origin.
// Reads run by default, writes only when asked, destructive actions never.

import { readFileSync } from "node:fs";
import { type Capability, canonicalJson, parseGraph } from "@kapabl/graph";
import { describe, expect, it } from "vitest";
import {
  ContractsFile,
  checkExample,
  runContracts,
  schemaExample,
  updateContracts,
} from "../src/contracts.ts";
import { compileHar } from "../src/har.ts";
import { mergeCapabilities } from "../src/merge.ts";
import { importOpenApi } from "../src/openapi.ts";

/** The graph as it comes back from disk: canonical JSON, keys sorted. */
function parseGraphSorted(graph: unknown) {
  return parseGraph(JSON.parse(canonicalJson(graph)));
}

import { scrubHar } from "../src/scrub.ts";

const raw = JSON.parse(readFileSync(new URL("./fixtures/acme.har", import.meta.url), "utf8"));
/** The scrubbed capture, replayed by the fake origin below. */
const captured = scrubHar(raw).har.log.entries;
const har = await compileHar(
  JSON.parse(readFileSync(new URL("./fixtures/acme.har", import.meta.url), "utf8")),
);
const approved = har.capabilities.map((c) => ({ ...c, approval: "approved" }) as Capability);
const contracts = updateContracts(undefined, har.apiOrigin, approved, har.examples);

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

/** A fake origin that answers like the captured API did. */
function origin(overrides: Record<string, () => Response> = {}) {
  const seen: Seen[] = [];
  const fetch = async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    seen.push({
      method,
      url: url.toString(),
      authorization: headers.get("authorization"),
      body: (init?.body as string) ?? null,
    });
    const key = `${method} ${url.pathname}`;
    if (overrides[key]) return overrides[key]();
    const replay = captured.find(
      (e) => e.request.method === method && new URL(e.request.url).pathname === url.pathname,
    );
    if (replay?.response.content.text) {
      return new Response(replay.response.content.text, {
        status: replay.response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

const base = { apiOrigin: "https://app.acme.test", authorization: "Bearer contract-token" };

describe("updateContracts", () => {
  it("seeds examples from the capture", () => {
    expect(ContractsFile.parse(contracts)).toEqual(contracts);
    expect(contracts.examples.get_invoice).toEqual({ invoice_id: "inv_8f3a2b9c" });
    expect(contracts.examples.list_invoices).toEqual({ status: "open", limit: 20 });
    expect(Object.keys(contracts.examples)).toEqual([...Object.keys(contracts.examples)].sort());
  });

  it("never invents an empty example for a write", () => {
    // The captured PATCH body was all personal data, so nothing survived to replay; a read
    // without required inputs still runs with no arguments.
    expect(contracts.examples.update_account).toBeUndefined();
    expect(contracts.examples.list_integrations).toEqual({});
  });

  it("lets a later capture fill an empty example", () => {
    const empty = { ...contracts, examples: { ...contracts.examples, get_invoice: {} } };
    const next = updateContracts(empty, har.apiOrigin, approved, har.examples);
    expect(next.examples.get_invoice).toEqual({ invoice_id: "inv_8f3a2b9c" });
    // An owner's empty example with nothing to replace it stays.
    const owned = { ...contracts, examples: { ...contracts.examples, update_account: {} } };
    expect(updateContracts(owned, har.apiOrigin, approved, {}).examples.update_account).toEqual({});
  });

  it("keeps the owner's edits and drops capabilities that are gone", () => {
    const edited = {
      ...contracts,
      examples: { ...contracts.examples, get_invoice: { invoice_id: "inv_mine" }, gone: {} },
    };
    const next = updateContracts(edited, har.apiOrigin, approved, har.examples);
    expect(next.examples.get_invoice).toEqual({ invoice_id: "inv_mine" });
    expect(next.examples.gone).toBeUndefined();
  });
});

describe("runContracts", () => {
  it("runs reads against the origin and checks status and response schema", async () => {
    const { fetch, seen } = origin();
    const results = await runContracts(approved, contracts, { ...base, fetch });
    expect(results).toEqual([
      {
        id: "delete_webhook",
        outcome: "skip",
        detail: "destructive actions are never run by contract tests",
      },
      { id: "get_invoice", outcome: "pass", detail: "GET /api/v1/invoices/{invoice_id} → 200" },
      { id: "list_integrations", outcome: "pass", detail: "GET /api/v1/integrations → 200" },
      { id: "list_invoices", outcome: "pass", detail: "GET /api/v1/invoices → 200" },
      {
        id: "refund_invoice",
        outcome: "skip",
        detail: "destructive actions are never run by contract tests",
      },
      { id: "update_account", outcome: "skip", detail: "writes run only with --include-writes" },
    ]);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://app.acme.test/api/v1/invoices/inv_8f3a2b9c",
      "GET https://app.acme.test/api/v1/integrations",
      "GET https://app.acme.test/api/v1/invoices?status=open&limit=20",
    ]);
    expect(seen.every((s) => s.authorization === "Bearer contract-token")).toBe(true);
  });

  it("fails on a non-2xx status or a response that breaks the schema", async () => {
    const { fetch } = origin({
      "GET /api/v1/invoices/inv_8f3a2b9c": () => new Response("{}", { status: 500 }),
      "GET /api/v1/invoices": () => Response.json({ data: "not a list" }),
    });
    const results = await runContracts(approved, contracts, { ...base, fetch });
    expect(results.find((r) => r.id === "get_invoice")).toMatchObject({
      outcome: "fail",
      detail: /→ 500, expected 2xx/,
    });
    expect(results.find((r) => r.id === "list_invoices")).toMatchObject({
      outcome: "fail",
      detail: /\/data must be array/,
    });
  });

  it("runs writes only when asked, with the owner's example as a JSON body", async () => {
    const { fetch, seen } = origin();
    const unset = await runContracts(approved, contracts, { ...base, fetch, includeWrites: true });
    expect(unset.find((r) => r.id === "update_account")).toMatchObject({
      outcome: "skip",
      detail: "no example arguments in the contracts file",
    });
    const owned = {
      ...contracts,
      examples: { ...contracts.examples, update_account: { display_name: "Ada" } },
    };
    const results = await runContracts(approved, owned, { ...base, fetch, includeWrites: true });
    expect(results.find((r) => r.id === "update_account")).toMatchObject({ outcome: "pass" });
    expect(seen.find((s) => s.method === "PATCH")).toMatchObject({
      body: '{"display_name":"Ada"}',
    });
    expect(seen.some((s) => s.method === "DELETE" || s.url.includes("refund"))).toBe(false);
  });

  it("goes by the method as well as the label", async () => {
    const { fetch, seen } = origin();
    const relabeled = approved.map((c) =>
      c.executor.kind === "http" &&
      (c.executor.method === "DELETE" || c.executor.method === "PATCH")
        ? ({ ...c, sideEffect: "read", auth: { kind: "oauth", scopes: ["x:read"] } } as Capability)
        : c,
    );
    const owned = {
      ...contracts,
      examples: { ...contracts.examples, update_account: { display_name: "Ada" } },
    };
    const results = await runContracts(relabeled, owned, { ...base, fetch });
    expect(results.find((r) => r.id === "delete_webhook")).toMatchObject({
      outcome: "skip",
      detail: "destructive actions are never run by contract tests",
    });
    expect(results.find((r) => r.id === "update_account")).toMatchObject({
      outcome: "skip",
      detail: "writes run only with --include-writes",
    });
    expect(seen.some((s) => s.method !== "GET")).toBe(false);
  });

  it("places a tenant secret where the capability says, as the edge does", async () => {
    const { fetch, seen } = origin();
    const keyed = approved.map((c) =>
      c.id === "list_integrations" && c.executor.kind === "http"
        ? ({
            ...c,
            executor: {
              ...c.executor,
              credential: {
                kind: "tenant-secret",
                secretRef: "TENANT_ACME_KEY",
                placement: { in: "header", name: "X-Acme-Key" },
              },
            },
          } as Capability)
        : c,
    );
    const missing = await runContracts(keyed, contracts, { ...base, fetch });
    expect(missing.find((r) => r.id === "list_integrations")).toMatchObject({
      outcome: "skip",
      detail: "needs the site's credential: set TENANT_ACME_KEY",
    });
    const headers: Headers[] = [];
    const spy = (async (input, init) => {
      headers.push(new Headers(init?.headers));
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const results = await runContracts(keyed, contracts, {
      ...base,
      fetch: spy,
      secrets: { TENANT_ACME_KEY: "k-123" },
    });
    expect(results.find((r) => r.id === "list_integrations")).toMatchObject({ outcome: "pass" });
    const sent = headers.find((h) => h.get("x-acme-key") !== null);
    expect(sent?.get("x-acme-key")).toBe("k-123");
    expect(sent?.get("authorization")).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("fails a response the edge could not return as structured output", async () => {
    const { fetch } = origin({
      "GET /api/v1/invoices/inv_8f3a2b9c": () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "text/plain" } }),
      "GET /api/v1/invoices": () => Response.json([]),
      "GET /api/v1/integrations": () =>
        new Response("x".repeat(1024 * 1024 + 1), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    const results = await runContracts(approved, contracts, { ...base, fetch });
    expect(results.find((r) => r.id === "get_invoice")?.detail).toMatch(/text\/plain, not JSON/);
    expect(results.find((r) => r.id === "list_invoices")?.detail).toMatch(/not a JSON object/);
    expect(results.find((r) => r.id === "list_integrations")?.detail).toMatch(/larger than/);
  });

  it("fails a sign-in page answered with 2xx even without a declared output", async () => {
    const { fetch } = origin({
      "GET /api/v1/invoices": () =>
        new Response("<html>Please log in</html>", { headers: { "Content-Type": "text/html" } }),
    });
    const bare = approved.map(({ outputSchema: _, ...c }) => c);
    const results = await runContracts(bare, contracts, { ...base, fetch });
    expect(results.find((r) => r.id === "list_invoices")).toMatchObject({
      outcome: "fail",
      detail: expect.stringMatching(/text\/html, not JSON/),
    });
  });

  it("skips without a credential, without examples, and ignores unapproved capabilities", async () => {
    const { fetch, seen } = origin();
    const noAuth = await runContracts(approved, contracts, { apiOrigin: base.apiOrigin, fetch });
    expect(noAuth.find((r) => r.id === "get_invoice")).toMatchObject({
      outcome: "skip",
      detail: /KAPABL_CONTRACT_AUTHORIZATION/,
    });
    const noExamples = await runContracts(
      approved,
      { ...contracts, examples: {} },
      { ...base, fetch },
    );
    expect(noExamples.find((r) => r.id === "get_invoice")).toMatchObject({
      outcome: "skip",
      detail: /no example/,
    });
    expect(await runContracts(har.capabilities, contracts, { ...base, fetch })).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("fails examples that do not match the input schema, before calling anything", async () => {
    const { fetch, seen } = origin();
    const bad = {
      ...contracts,
      examples: { ...contracts.examples, list_invoices: { limit: "many" } },
    };
    const results = await runContracts(approved, bad, { ...base, fetch });
    expect(results.find((r) => r.id === "list_invoices")).toMatchObject({
      outcome: "fail",
      detail: /input schema: \/limit must be integer/,
    });
    expect(seen.some((s) => s.url.includes("limit=many"))).toBe(false);
  });

  it("refuses path arguments that would leave the origin's path", async () => {
    const { fetch, seen } = origin();
    const sneaky = {
      ...contracts,
      examples: { get_invoice: { invoice_id: "../../admin" } },
    };
    const results = await runContracts(approved, sneaky, { ...base, fetch });
    expect(results.find((r) => r.id === "get_invoice")).toMatchObject({
      outcome: "fail",
      detail: 'example argument "invoice_id" is not a valid path segment',
    });
    expect(seen).toEqual([]);
  });

  it("refuses dot-segment path arguments, as the edge does", async () => {
    const { fetch, seen } = origin();
    const dots = { ...contracts, examples: { get_invoice: { invoice_id: ".." } } };
    const results = await runContracts(approved, dots, { ...base, fetch });
    expect(results.find((r) => r.id === "get_invoice")).toMatchObject({
      outcome: "fail",
      detail: 'example argument "invoice_id" is not a valid path segment',
    });
    expect(seen).toEqual([]);
  });

  it("does not follow redirects", async () => {
    const { fetch } = origin({
      "GET /api/v1/integrations": () =>
        new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
    });
    const results = await runContracts(approved, contracts, { ...base, fetch });
    expect(results.find((r) => r.id === "list_integrations")).toMatchObject({
      outcome: "fail",
      detail: /302/,
    });
  });
});

describe("mergeCapabilities", () => {
  it("adds, replaces by id and keeps everything else", () => {
    const first = mergeCapabilities(undefined, "acme", har.capabilities.slice(0, 2));
    expect(first.added).toHaveLength(2);
    const changed = { ...(har.capabilities[0] as Capability), title: "Changed" };
    const second = mergeCapabilities(first.graph, "acme", [
      changed,
      ...(har.capabilities.slice(2) as Capability[]),
    ]);
    expect(second.updated).toEqual([changed.id]);
    expect(second.added).toHaveLength(har.capabilities.length - 2);
    expect(second.graph.capabilities).toHaveLength(har.capabilities.length);
    expect(mergeCapabilities(second.graph, "acme", [changed]).unchanged).toEqual([changed.id]);
    expect(() => mergeCapabilities(second.graph, "globex", [])).toThrow(/tenant/);
  });

  it("compares canonically: a stored graph's sorted keys are not a change", () => {
    const stored = JSON.parse(
      JSON.stringify(mergeCapabilities(undefined, "acme", har.capabilities).graph),
    );
    const refund = har.capabilities.find((c) => c.id === "refund_invoice") as Capability;
    expect(Object.keys(refund.inputSchema.properties ?? {})[0]).toBe("invoice_id");
    expect(mergeCapabilities(parseGraphSorted(stored), "acme", har.capabilities).updated).toEqual(
      [],
    );
  });
});

describe("examples from an OpenAPI document", () => {
  const spec = `openapi: 3.1.0
info: {title: Ex, version: "1"}
servers: [{url: "https://ex.example"}]
paths:
  /invoices/{invoiceId}:
    get:
      operationId: getInvoice
      parameters:
        - {name: invoiceId, in: path, required: true, schema: {type: string}, example: inv_1}
        - {name: expand, in: query, schema: {type: string}, examples: {one: {value: lines}}}
      responses: {"200": {description: ok}}
  /reports:
    get:
      operationId: listReports
      parameters:
        - {name: month, in: query, required: true, schema: {type: string}}
      responses: {"200": {description: ok}}
  /invoices:
    post:
      operationId: createInvoice
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties: {amount: {type: integer, example: 100}}
      responses: {"201": {description: ok}}
`;

  it("seeds reads from the document's examples, and never writes", async () => {
    const result = await importOpenApi(spec);
    const out = updateContracts(undefined, result.apiOrigin, result.capabilities);
    expect(out.examples.get_invoice).toEqual({ invoice_id: "inv_1", expand: "lines" });
    // A required input with no example leaves the read for the owner.
    expect(out.examples.list_reports).toBeUndefined();
    // Writes wait for the owner even when the document has an example.
    expect(out.examples.create_invoice).toBeUndefined();
  });

  it("checks owner examples against the input schema", async () => {
    const { capabilities } = await importOpenApi(spec);
    const get = capabilities.find((c) => c.id === "get_invoice") as Capability;
    expect(checkExample(get, { invoice_id: "inv_2" })).toBeUndefined();
    expect(checkExample(get, {})).toMatch(/invoice_id/);
    expect(schemaExample(get)).toEqual({ invoice_id: "inv_1", expand: "lines" });
  });
});
