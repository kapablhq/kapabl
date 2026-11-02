// SPDX-License-Identifier: Apache-2.0
// AGENTS.md H5: the emitted document is OpenAPI 3.1, validates against the official
// schema (fixtures/oas-3.1.schema.json, from spec.openapis.org, Apache-2.0), and
// imports back into the same capabilities.

import { readFileSync } from "node:fs";
import { compileHar, importOpenApi } from "@kapabl/compiler";
import type { Capability } from "@kapabl/graph";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import fixture from "../../graph/test/fixtures/graph.json" with { type: "json" };
import { openApiDocument } from "../src/index.ts";
import oasSchema from "./fixtures/oas-3.1.schema.json" with { type: "json" };

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Ajv resolves the spec's `$dynamicRef: "#meta"` to the wrong anchor; this schema's own
// default target is `#/$defs/schema` (an object or boolean), so point there statically.
const validate = ajv.compile(
  JSON.parse(
    JSON.stringify(oasSchema).replaceAll('"$dynamicRef":"#meta"', '"$ref":"#/$defs/schema"'),
  ),
);
const info = { title: "Acme API", version: "1.0.0", apiOrigin: "https://api.acme.test" };

const billing = await importOpenApi(
  readFileSync(
    new URL("../../compiler/test/fixtures/billing.openapi.yaml", import.meta.url),
    "utf8",
  ),
);
const har = await compileHar(
  JSON.parse(
    readFileSync(new URL("../../compiler/test/fixtures/acme.har", import.meta.url), "utf8"),
  ),
);

function shape(capabilities: readonly Capability[]) {
  return capabilities
    .map((c) => ({
      id: c.id,
      method: c.executor.kind === "http" ? c.executor.method : "",
      path: c.executor.kind === "http" ? c.executor.path : "",
      input: c.inputSchema,
      output: c.outputSchema,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe("openApiDocument", () => {
  it.each([
    ["the graph fixture", (fixture as { capabilities: Capability[] }).capabilities],
    ["an imported OpenAPI 3.0 document", billing.capabilities],
    ["a compiled HAR capture", har.capabilities],
  ])("validates against the OpenAPI 3.1 schema: %s", (_, capabilities) => {
    const { document } = openApiDocument(info, capabilities);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(document.openapi).toBe("3.1.1");
  });

  it.each([
    ["an imported OpenAPI 3.0 document", billing.capabilities],
    ["a compiled HAR capture", har.capabilities],
  ])("round-trips through the importer: %s", async (_, capabilities) => {
    const { document, skipped } = openApiDocument(info, capabilities);
    expect(skipped).toEqual([]);
    const back = await importOpenApi(document);
    expect(back.skipped).toEqual([]);
    expect(shape(back.capabilities)).toEqual(shape(capabilities));
    for (const c of back.capabilities) {
      const original = capabilities.find((o) => o.id === c.id);
      expect(c.sideEffect).toBe(original?.sideEffect);
      expect(c.executor.kind === "http" && c.executor.credential.kind).toBe(
        original?.executor.kind === "http" && original.executor.credential.kind === "none"
          ? "none"
          : "tenant-secret",
      );
    }
  });

  it("describes credentials without naming any secret", () => {
    const { document } = openApiDocument(info, har.capabilities);
    expect(document.components).toEqual({
      securitySchemes: {
        userToken: expect.objectContaining({ type: "http", scheme: "bearer" }),
      },
    });
    expect(JSON.stringify(document)).not.toMatch(/SECRET/);
  });

  it("is deterministic and skips what it cannot describe", () => {
    const caps = billing.capabilities;
    expect(JSON.stringify(openApiDocument(info, [...caps].reverse()))).toBe(
      JSON.stringify(openApiDocument(info, caps)),
    );
    const first = caps[0] as Capability;
    const withRef = {
      ...first,
      id: "with_ref",
      inputSchema: {
        ...first.inputSchema,
        $defs: { a: { type: "string" } },
        properties: { x: { $ref: "#/$defs/a" } },
      },
    };
    const duplicate = { ...first, id: "zz_duplicate" };
    const { skipped } = openApiDocument(info, [first, withRef as Capability, duplicate]);
    expect(skipped.map((s) => s.id)).toEqual(["with_ref", "zz_duplicate"]);
  });
  it("skips a path that differs from a described one only in variable names", () => {
    const get = http("get_order", "GET", "/orders/{id}", { id: { type: "string" } });
    const del = http("zz_delete_order", "DELETE", "/orders/{order_id}", {
      order_id: { type: "string" },
    });
    const { document, skipped } = openApiDocument(info, [get, del]);
    expect(skipped).toEqual([
      { id: "zz_delete_order", reason: "/orders/{order_id} is already described as /orders/{id}" },
    ]);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  });

  it("describes inputs where the executor sends them", () => {
    const list = http("list_orders", "GET", "/orders", {
      tags: { type: "array", items: { type: "string" } },
      filter: { type: "object", properties: { status: { type: "string" } } },
    });
    const create = {
      ...http(
        "create_order",
        "POST",
        "/orders",
        { dry_run: { type: "boolean" }, item: { type: "string" } },
        { additionalProperties: true },
      ),
      executor: { ...httpExecutor("POST", "/orders"), query: ["dry_run"] },
    } as Capability;
    const { document } = openApiDocument(info, [list, create]);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    const orders = (document.paths as Record<string, Record<string, Op>>)["/orders"] as Record<
      string,
      Op
    >;
    // Arrays of scalars go as repeated name=value; objects as one JSON value.
    expect(orders.get?.parameters).toEqual([
      {
        name: "tags",
        in: "query",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "filter",
        in: "query",
        required: false,
        content: {
          "application/json": {
            schema: { type: "object", properties: { status: { type: "string" } } },
          },
        },
      },
    ]);
    expect(orders.post?.parameters).toEqual([
      { name: "dry_run", in: "query", required: false, schema: { type: "boolean" } },
    ]);
    // The body keeps the input's own keywords instead of a forced additionalProperties: false.
    expect(orders.post?.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: true,
            properties: { item: { type: "string" } },
          },
        },
      },
    });
  });

  it("decides a query parameter's form by the values it allows, as the executor does", () => {
    const list = http("list_orders", "GET", "/orders", {
      kinds: { type: "array", items: { enum: ["a", "b"] } },
      ids: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
      sort: { enum: ["asc", "desc"] },
      meta: { type: ["object", "null"] },
    });
    const { document } = openApiDocument(info, [list]);
    const get = (document.paths as Record<string, Record<string, Op>>)["/orders"]?.get;
    const parameters = (get?.parameters ?? []) as Schema[];
    expect(parameters.map((p) => [p.name, "content" in p ? "json" : "form"])).toEqual([
      ["kinds", "form"],
      ["ids", "form"],
      ["sort", "form"],
      ["meta", "json"],
    ]);
    for (const prop of [
      {},
      true,
      { type: ["string", "object"] },
      { type: "array" },
      { type: "array", prefixItems: [{ type: "object" }], items: { type: "string" } },
    ]) {
      const vague = http("list_things", "GET", "/things", { q: prop });
      expect(openApiDocument(info, [vague]).skipped).toEqual([
        {
          id: "list_things",
          reason: "the query parameters q are sent in more than one form depending on the value",
        },
      ]);
    }
  });

  it("skips a body operation with query inputs whose input constrains them together", () => {
    const post = {
      ...http(
        "create_order",
        "POST",
        "/orders",
        { q: { type: "string" }, b: { type: "string" } },
        { anyOf: [{ required: ["q"] }, { required: ["b"] }] },
      ),
      executor: { ...httpExecutor("POST", "/orders"), query: ["q"] },
    } as Capability;
    expect(openApiDocument(info, [post]).skipped).toEqual([
      {
        id: "create_order",
        reason:
          "its input schema uses anyOf, which cannot hold across inputs sent in the path or query",
      },
    ]);
  });

  it("skips a split body whose input enumerates whole objects", () => {
    const put = http(
      "replace_note",
      "PUT",
      "/notes/{id}",
      { id: { type: "string" }, kind: { type: "string" } },
      { required: ["id"], enum: [{ id: "a", kind: "x" }] },
    );
    expect(openApiDocument(info, [put]).skipped).toEqual([
      {
        id: "replace_note",
        reason:
          "its input schema uses enum, which cannot hold across inputs sent in the path or query",
      },
    ]);
  });

  it("skips a body operation with path inputs whose input constrains them together", () => {
    const post = http(
      "update_order",
      "POST",
      "/orders/{order_id}",
      { order_id: { type: "string" }, note: { type: "string" } },
      { required: ["order_id"], minProperties: 2 },
    );
    expect(openApiDocument(info, [post]).skipped).toEqual([
      {
        id: "update_order",
        reason:
          "its input schema uses minProperties, which cannot hold across inputs sent in the path or query",
      },
    ]);
  });

  it("skips a query-only operation whose input constrains several properties together", () => {
    const one = http(
      "list_orders",
      "GET",
      "/orders",
      { a: { type: "string" }, b: { type: "string" } },
      { oneOf: [{ required: ["a"] }, { required: ["b"] }] },
    );
    expect(openApiDocument(info, [one]).skipped).toEqual([
      {
        id: "list_orders",
        reason:
          "its input schema uses oneOf, which cannot hold across inputs sent in the path or query",
      },
    ]);
  });

  it("describes each credential placement as the scheme the executor uses", () => {
    const secret = (placement?: unknown) => ({
      kind: "tenant-secret",
      secretRef: "TENANT_KEY",
      ...(placement ? { placement } : {}),
    });
    const caps = [
      ["a_bearer", undefined],
      ["b_basic", { in: "authorization", scheme: "basic" }],
      ["c_header", { in: "header", name: "X-Api-Key" }],
      ["d_query", { in: "query", name: "api_key" }],
    ].map(([id, placement], i) => ({
      ...http(id as string, "GET", `/r${i}`, {}),
      executor: { ...httpExecutor("GET", `/r${i}`), credential: secret(placement) },
    })) as Capability[];
    const { document } = openApiDocument(info, caps);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect((document.components as { securitySchemes: unknown }).securitySchemes).toEqual({
      apiKey: expect.objectContaining({ type: "http", scheme: "bearer" }),
      "apiKey_header_X-Api-Key": expect.objectContaining({
        type: "apiKey",
        in: "header",
        name: "X-Api-Key",
      }),
      apiKey_query_api_key: expect.objectContaining({
        type: "apiKey",
        in: "query",
        name: "api_key",
      }),
      basicAuth: expect.objectContaining({ type: "http", scheme: "basic" }),
    });
    const security = (path: string) =>
      (document.paths as Record<string, Record<string, Op>>)[path]?.get?.security;
    expect(security("/r2")).toEqual([{ "apiKey_header_X-Api-Key": [] }]);
    expect(JSON.stringify(document)).not.toContain("TENANT_KEY");
  });
});

type Schema = Record<string, unknown>;
type Op = { parameters?: unknown[]; requestBody?: unknown; security?: unknown };

function httpExecutor(method: string, path: string) {
  return { kind: "http", method, path, credential: { kind: "none" } };
}

function http(
  id: string,
  method: string,
  path: string,
  properties: Record<string, unknown>,
  keywords: Record<string, unknown> = {},
): Capability {
  return {
    id,
    title: id,
    description: id,
    sideEffect: method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write",
    inputSchema: { type: "object", properties, ...keywords },
    auth: method === "DELETE" ? { kind: "oauth", scopes: ["orders:write"] } : { kind: "none" },
    executor: httpExecutor(method, path),
    provenance: { source: "manual" },
    confidence: 1,
    approval: "approved",
  } as Capability;
}
