// SPDX-License-Identifier: Apache-2.0
// OpenAPI 3.0 and 3.1 import (AGENTS.md H5), through the same builder as HAR inference.

import { readFileSync } from "node:fs";
import { Capability, sha256Text } from "@kapabl/graph";
import { describe, expect, it } from "vitest";
import { importOpenApi } from "../src/openapi.ts";

const yaml = readFileSync(new URL("./fixtures/billing.openapi.yaml", import.meta.url), "utf8");
const result = await importOpenApi(yaml);
const byId = new Map(result.capabilities.map((c) => [c.id, c]));

describe("importOpenApi (3.0 YAML)", () => {
  it("imports operations in path order with the base path from servers[0]", () => {
    expect(result.version).toBe("3.0");
    expect(result.apiOrigin).toBe("https://api.acme.test");
    expect(
      result.capabilities.map((c) => [
        c.id,
        c.executor.kind === "http" ? `${c.executor.method} ${c.executor.path}` : "",
      ]),
    ).toEqual([
      ["list_invoices", "GET /v2/invoices"],
      ["create_invoice", "POST /v2/invoices"],
      ["get_invoice", "GET /v2/invoices/{invoice_id}"],
      ["partner_usage", "GET /v2/partners/{partner_id}/usage"],
      ["get_status", "GET /v2/status"],
    ]);
  });

  it("every capability is valid, pending and points at the document digest", async () => {
    const digest = await sha256Text(yaml);
    expect(result.document).toBe(digest);
    for (const c of result.capabilities) {
      expect(Capability.safeParse(c).success).toBe(true);
      expect(c.approval).toBe("pending");
      expect(c.confidence).toBe(0.9);
      expect(c.provenance).toMatchObject({ source: "openapi", document: digest });
    }
  });

  it("skips what cannot be called safely, saying why", () => {
    expect(result.skipped).toEqual([
      { method: "DELETE", path: "/v2/invoices/{invoiceId}", reason: "the operation is deprecated" },
      {
        method: "POST",
        path: "/v2/invoices/{invoiceId}/refunds",
        reason: 'needs header "Idempotency-Key", which is not supported yet',
      },
      { method: "POST", path: "/v2/reports/export", reason: "the request body is not JSON" },
    ]);
  });

  it("ignores Accept and Content-Type header parameters, as OpenAPI says to", async () => {
    const accept = {
      name: "Accept",
      in: "header",
      required: true,
      schema: { type: "string", default: "application/vnd.pagerduty+json;version=2" },
    };
    const r = await importOpenApi({
      openapi: "3.0.3",
      info: { title: "PD", version: "1" },
      servers: [{ url: "https://api.pd.test" }],
      paths: {
        "/abilities": {
          get: {
            operationId: "listAbilities",
            parameters: [accept, { name: "Content-Type", in: "header", required: true }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(r.skipped).toEqual([]);
    expect(r.capabilities.map((c) => c.id)).toEqual(["list_abilities"]);
    expect(r.capabilities[0]?.inputSchema.properties).toEqual({});
  });

  it("maps security: oauth2 → signed-in user with declared scopes and exchanged token", () => {
    expect(byId.get("list_invoices")?.auth).toEqual({ kind: "oauth", scopes: ["billing.read"] });
    expect(byId.get("create_invoice")?.auth).toEqual({ kind: "oauth", scopes: ["billing.write"] });
    expect(byId.get("get_invoice")?.executor).toMatchObject({
      credential: { kind: "token-exchange", audience: "https://api.acme.test" },
    });
  });

  it("maps security: apiKey → tenant secret, `{}` → anonymous", () => {
    expect(byId.get("partner_usage")?.auth).toEqual({ kind: "none" });
    expect(byId.get("partner_usage")?.executor).toMatchObject({
      credential: { kind: "tenant-secret", secretRef: "TENANT_PARTNER_KEY" },
    });
    expect(byId.get("get_status")?.executor).toMatchObject({ credential: { kind: "none" } });
  });

  it("renames path variables to snake_case and keeps parameter descriptions", () => {
    expect(byId.get("get_invoice")?.inputSchema).toEqual({
      type: "object",
      properties: { invoice_id: { type: "string", description: "The invoice." } },
      required: ["invoice_id"],
      additionalProperties: false,
    });
  });

  it("inlines refs and up-converts 3.0 schemas; readOnly fields are not inputs", () => {
    expect(byId.get("create_invoice")?.inputSchema).toEqual({
      type: "object",
      properties: {
        customer: { type: "string" },
        total: { type: "number" },
        memo: { type: ["string", "null"] },
        discriminatorField: { type: "string" },
      },
      required: ["customer", "total"],
      additionalProperties: false,
    });
    const out = JSON.stringify(result.capabilities);
    expect(out).not.toContain("$ref");
    expect(out).not.toContain("x-");
    expect(out).not.toContain("nullable");
    expect(out).not.toContain('discriminator"');
  });

  it("cuts recursive schemas off where they repeat", () => {
    const out = byId.get("partner_usage")?.outputSchema as unknown as {
      properties: { children: { items: object } };
    };
    expect(out.properties.children.items).toEqual({});
  });

  it("query parameters come from refs and inline definitions", () => {
    expect(byId.get("list_invoices")?.inputSchema).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", maximum: 100 },
        status: { type: "string", enum: ["open", "paid", "void"] },
      },
      additionalProperties: false,
    });
  });
});

describe("importOpenApi (3.1 and edge cases)", () => {
  const doc31 = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    servers: [{ url: "/api" }],
    paths: {
      "/orders/{id}/cancel": {
        post: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { reason: { type: ["string", "null"], examples: ["late"] } },
                },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/things": {
        get: {
          parameters: [
            { name: "min", in: "query", schema: { type: "number", exclusiveMinimum: 0 } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  it("needs an API origin when servers[0] is relative", async () => {
    await expect(importOpenApi(doc31)).rejects.toThrow(/pass the API origin/);
  });

  it("imports 3.1 as-is and marks cancel destructive with a derived user scope", async () => {
    const r = await importOpenApi(doc31, { apiOrigin: "https://shop.test" });
    expect(r.version).toBe("3.1");
    const cancel = r.capabilities.find((c) => c.id === "cancel_order");
    expect(cancel?.sideEffect).toBe("destructive");
    expect(cancel?.auth).toEqual({ kind: "oauth", scopes: ["orders:write"] });
    expect(cancel?.executor).toMatchObject({ path: "/api/orders/{id}/cancel" });
    expect(cancel?.inputSchema.properties).toEqual({
      id: { type: "string" },
      reason: { type: ["string", "null"], examples: ["late"] },
    });
    const things = r.capabilities.find((c) => c.id === "list_things");
    expect(things?.inputSchema.properties).toEqual({
      min: { type: "number", exclusiveMinimum: 0 },
    });
  });

  it("rejects Swagger 2.0, non-documents and remote refs", async () => {
    await expect(importOpenApi({ swagger: "2.0" })).rejects.toThrow(/Swagger 2.0/);
    await expect(importOpenApi("just text")).rejects.toThrow(/not an OpenAPI/);
    const remote = await importOpenApi({
      openapi: "3.1.0",
      servers: [{ url: "https://x.test" }],
      paths: {
        "/a": {
          get: {
            responses: {
              "200": {
                content: { "application/json": { schema: { $ref: "https://evil.test/s.json" } } },
              },
            },
          },
        },
      },
    });
    expect(remote.skipped).toEqual([
      {
        method: "GET",
        path: "/a",
        reason: 'remote $ref "https://evil.test/s.json" is not supported',
      },
    ]);
  });

  it("parses JSON text too", async () => {
    const r = await importOpenApi(JSON.stringify(doc31), { apiOrigin: "https://shop.test" });
    expect(r.capabilities).toHaveLength(2);
  });
});

/** A 3.1 document on https://x.test with the given paths and components. */
function doc(paths: Record<string, unknown>, components: Record<string, unknown> = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    servers: [{ url: "https://x.test/v1" }],
    paths,
    components,
  };
}
const ok = { "200": { description: "ok" } };
const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

describe("importOpenApi (security placement)", () => {
  const schemes = {
    securitySchemes: {
      header: { type: "apiKey", in: "header", name: "X-Api-Key" },
      query: { type: "apiKey", in: "query", name: "key" },
      basic: { type: "http", scheme: "basic" },
      bearer: { type: "http", scheme: "bearer" },
      cookie: { type: "apiKey", in: "cookie", name: "sid" },
    },
  };
  const op = (scheme: string, parameters: unknown[] = []) => ({
    get: { security: [{ [scheme]: [] }], parameters, responses: ok },
  });

  it("sends each kind of key where the spec says", async () => {
    const r = await importOpenApi(
      doc(
        {
          "/a": op("header"),
          "/b": op("query", [{ name: "key", in: "query", schema: { type: "string" } }]),
          "/c": op("basic"),
          "/d": op("bearer"),
        },
        schemes,
      ),
    );
    const credential = (path: string) => {
      const c = r.capabilities.find((x) => x.executor.kind === "http" && x.executor.path === path);
      return c?.executor.kind === "http" ? c.executor.credential : undefined;
    };
    expect(credential("/v1/a")).toEqual({
      kind: "tenant-secret",
      secretRef: "TENANT_HEADER",
      placement: { in: "header", name: "X-Api-Key" },
    });
    expect(credential("/v1/b")).toMatchObject({ placement: { in: "query", name: "key" } });
    // The query key is the credential's, never an input an agent fills in.
    const b = r.capabilities.find((x) => x.executor.kind === "http" && x.executor.path === "/v1/b");
    expect(b?.inputSchema.properties).toEqual({});
    expect(credential("/v1/c")).toMatchObject({
      placement: { in: "authorization", scheme: "basic" },
    });
    expect(credential("/v1/d")).toEqual({ kind: "tenant-secret", secretRef: "TENANT_BEARER" });
  });

  it("skips an operation whose only way in is a cookie key", async () => {
    const r = await importOpenApi(doc({ "/a": op("cookie") }, schemes));
    expect(r.skipped).toEqual([
      { method: "GET", path: "/v1/a", reason: "API keys sent in a cookie are not supported" },
    ]);
  });
});

describe("importOpenApi (parameters the executor cannot send)", () => {
  it("leaves out optional ones and skips operations that need one", async () => {
    const r = await importOpenApi(
      doc({
        "/list": {
          get: {
            parameters: [
              { name: "created", in: "query", style: "deepObject", schema: { type: "object" } },
              {
                name: "ids",
                in: "query",
                explode: false,
                schema: { type: "array", items: { type: "string" } },
              },
              { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
              {
                name: "filter",
                in: "query",
                content: { "application/json": { schema: { type: "object" } } },
              },
            ],
            responses: ok,
          },
        },
        "/need": {
          get: {
            parameters: [
              {
                name: "range",
                in: "query",
                required: true,
                style: "deepObject",
                schema: { type: "object" },
              },
            ],
            responses: ok,
          },
        },
        "/m/{id}": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                style: "matrix",
                schema: { type: "string" },
              },
            ],
            responses: ok,
          },
        },
      }),
    );
    expect(Object.keys(r.capabilities[0]?.inputSchema.properties ?? {})).toEqual([
      "tags",
      "filter",
    ]);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      'path parameter "id" uses matrix style, which is not supported',
      'query parameter "range" is an object sent as deepObject fields, which is not supported',
    ]);
  });

  it("sends a body method's query parameters in the query", async () => {
    const r = await importOpenApi(
      doc({
        "/notes": {
          post: {
            parameters: [{ name: "draft", in: "query", schema: { type: "boolean" } }],
            requestBody: json({ type: "object", properties: { text: { type: "string" } } }),
            responses: ok,
          },
        },
      }),
    );
    const [c] = r.capabilities;
    expect(c?.executor).toMatchObject({ query: ["draft"] });
    expect(Object.keys(c?.inputSchema.properties ?? {})).toEqual(["draft", "text"]);
  });
});

describe("importOpenApi (schemas)", () => {
  it("inlines refs under every applicator, keeps boolean schemas, converts dependencies", async () => {
    const r = await importOpenApi(
      doc(
        {
          "/a": {
            post: {
              requestBody: json({
                type: "object",
                properties: {
                  meta: {
                    type: "object",
                    unevaluatedProperties: { $ref: "#/components/schemas/S" },
                  },
                  blob: { type: "string", contentSchema: { $ref: "#/components/schemas/S" } },
                  never: false,
                  card: {
                    type: "object",
                    dependencies: { number: ["cvc"], kind: { $ref: "#/components/schemas/S" } },
                  },
                },
              }),
              responses: ok,
            },
          },
        },
        { schemas: { S: { type: "string", minLength: 1 } } },
      ),
    );
    const properties = r.capabilities[0]?.inputSchema.properties as Record<string, unknown>;
    expect(JSON.stringify(properties)).not.toContain("$ref");
    expect(properties.never).toBe(false);
    expect(properties.card).toEqual({
      type: "object",
      dependentRequired: { number: ["cvc"] },
      dependentSchemas: { kind: { type: "string", minLength: 1 } },
    });
  });

  it("applies keywords next to a $ref together with the target", async () => {
    const r = await importOpenApi(
      doc(
        {
          "/a": {
            get: {
              responses: {
                "200": json({
                  type: "object",
                  properties: {
                    described: { $ref: "#/components/schemas/S", description: "Its name." },
                    narrowed: { $ref: "#/components/schemas/S", maxLength: 3 },
                  },
                }),
              },
            },
          },
        },
        { schemas: { S: { type: "string", minLength: 1 } } },
      ),
    );
    expect(r.capabilities[0]?.outputSchema?.properties).toEqual({
      described: { type: "string", minLength: 1, description: "Its name." },
      narrowed: { allOf: [{ type: "string", minLength: 1 }, { maxLength: 3 }] },
    });
  });

  it("drops readOnly from requests and writeOnly from responses at every depth", async () => {
    const user = {
      type: "object",
      required: ["id", "profile", "welcome_note"],
      properties: {
        id: { type: "string", readOnly: true },
        welcome_note: { type: "string", writeOnly: true },
        profile: {
          type: "object",
          required: ["created_at", "bio"],
          properties: { created_at: { type: "string", readOnly: true }, bio: { type: "string" } },
        },
      },
    };
    const r = await importOpenApi(
      doc({ "/users": { post: { requestBody: json(user), responses: { "201": json(user) } } } }),
    );
    const [c] = r.capabilities;
    expect(c?.inputSchema.required).toEqual(["welcome_note", "profile"]);
    expect(c?.inputSchema.properties?.profile).toEqual({
      type: "object",
      required: ["bio"],
      properties: { bio: { type: "string" } },
    });
    expect(c?.outputSchema?.required).toEqual(["id", "profile"]);
    expect(Object.keys(c?.outputSchema?.properties ?? {})).toEqual(["id", "profile"]);
  });

  it("merges an allOf extension into one body", async () => {
    const r = await importOpenApi(
      doc(
        {
          "/pets": {
            post: {
              requestBody: json({
                allOf: [
                  { $ref: "#/components/schemas/Base" },
                  { type: "object", required: ["kind"], properties: { kind: { type: "string" } } },
                ],
              }),
              responses: ok,
            },
          },
        },
        {
          schemas: {
            Base: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          },
        },
      ),
    );
    expect(r.capabilities[0]?.inputSchema).toMatchObject({
      properties: { name: { type: "string" }, kind: { type: "string" } },
      required: ["name", "kind"],
    });
  });

  it("skips an operation whose schemas would take too long to inline", async () => {
    const schemas: Record<string, unknown> = { L0: { type: "string" } };
    for (let i = 1; i <= 20; i++) {
      schemas[`L${i}`] = {
        type: "object",
        properties: {
          a: { $ref: `#/components/schemas/L${i - 1}` },
          b: { $ref: `#/components/schemas/L${i - 1}` },
        },
      };
    }
    const r = await importOpenApi(
      doc(
        { "/big": { get: { responses: { "200": json({ $ref: "#/components/schemas/L20" }) } } } },
        { schemas },
      ),
    );
    expect(r.capabilities).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/too large to inline/);
  });
});

describe("importOpenApi (servers and broken paths)", () => {
  it("uses a path's own server on the same origin and skips one on another", async () => {
    const r = await importOpenApi(
      doc({
        "/a": { servers: [{ url: "https://x.test/v2" }], get: { responses: ok } },
        "/b": { get: { servers: [{ url: "https://files.x.test" }], responses: ok } },
      }),
    );
    expect(r.capabilities.map((c) => c.executor.kind === "http" && c.executor.path)).toEqual([
      "/v2/a",
    ]);
    expect(r.skipped).toEqual([
      {
        method: "GET",
        path: "/b",
        reason: "it is served from https://files.x.test, not https://x.test",
      },
    ]);
  });

  it("skips a path item whose $ref does not resolve and imports the rest", async () => {
    const r = await importOpenApi(
      doc({ "/a": { $ref: "#/components/pathItems/missing" }, "/b": { get: { responses: ok } } }),
    );
    expect(r.capabilities).toHaveLength(1);
    expect(r.skipped).toEqual([
      { method: "*", path: "/a", reason: '$ref "#/components/pathItems/missing" does not resolve' },
    ]);
  });
});

describe("importOpenApi (round 2)", () => {
  it("never turns an undefined or combined security scheme into anonymous access", async () => {
    const r = await importOpenApi(
      doc(
        {
          "/notes": { post: { security: [{ bearerAuth: [] }], responses: ok } },
          "/both": { post: { security: [{ key: [], user: ["notes"] }], responses: ok } },
        },
        {
          securitySchemes: {
            key: { type: "apiKey", in: "header", name: "X-Key" },
            user: { type: "oauth2", flows: {} },
          },
        },
      ),
    );
    expect(r.capabilities).toEqual([]);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual([
      "it needs key and user together, which is not supported",
      'its security scheme "bearerAuth" is not defined',
    ]);
  });

  it("up-converts 3.0 nullable with an enum and next to a $ref", async () => {
    const r = await importOpenApi({
      ...doc({
        "/a": {
          get: {
            responses: {
              "200": json({
                type: "object",
                properties: {
                  state: { type: "string", enum: ["x", "y"], nullable: true },
                  owner: { $ref: "#/components/schemas/User", nullable: true },
                },
              }),
            },
          },
        },
      }),
      openapi: "3.0.3",
      components: { schemas: { User: { type: "object", properties: { id: { type: "string" } } } } },
    });
    const out = r.capabilities[0]?.outputSchema?.properties as Record<string, unknown>;
    expect(out.state).toEqual({ type: ["string", "null"], enum: ["x", "y", null] });
    expect(out.owner).toEqual({
      anyOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: "null" }],
    });
  });

  it("skips bodies it cannot send or cannot list", async () => {
    const r = await importOpenApi(
      doc({
        "/patch": {
          patch: {
            requestBody: {
              content: { "application/merge-patch+json": { schema: { type: "object" } } },
            },
            responses: ok,
          },
        },
        "/pick": {
          post: {
            requestBody: json({
              type: "object",
              oneOf: [{ properties: { cat: { type: "string" } }, required: ["cat"] }],
            }),
            responses: ok,
          },
        },
        "/map": {
          post: {
            requestBody: json({ type: "object", additionalProperties: { type: "string" } }),
            responses: ok,
          },
        },
      }),
    );
    expect(r.capabilities).toEqual([]);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual([
      "the request body is sent as application/merge-patch+json, not application/json",
      "the request body's fields cannot be listed (oneOf, anyOf or a free-form map)",
      "the request body's fields cannot be listed (oneOf, anyOf or a free-form map)",
    ]);
  });

  it("refuses a server URL with no scheme", async () => {
    await expect(
      importOpenApi({
        ...doc({ "/a": { get: { responses: ok } } }),
        servers: [{ url: "api.x.test/v1" }],
      }),
    ).rejects.toThrow(/pass the API origin/);
  });
});
