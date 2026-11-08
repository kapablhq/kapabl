// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Capability,
  canonicalJson,
  emittableCapabilities,
  emptyLockfile,
  fillPath,
  type Graph,
  graphDigest,
  originRequest,
  parseGraph,
  pathVariables,
  placeSecret,
  recordDecision,
  serializeGraph,
} from "../src/index.ts";

const at = new Date("2026-10-30T12:00:00Z");

const fixtureText = readFileSync(new URL("./fixtures/graph.json", import.meta.url), "utf8");
const fixture = (): Graph => parseGraph(JSON.parse(fixtureText));
const capability = (id: string): Capability => {
  const found = fixture().capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`no fixture capability ${id}`);
  return found;
};
const withCapability = (patch: Record<string, unknown>) => ({
  ...fixture(),
  capabilities: [{ ...capability("search_docs"), ...patch }],
});

describe("graph round-trip", () => {
  it("serializes the canonical fixture byte-for-byte", () => {
    expect(serializeGraph(fixture())).toBe(fixtureText);
  });

  it("parses what it serializes", () => {
    const graph = fixture();
    expect(parseGraph(JSON.parse(serializeGraph(graph)))).toEqual(graph);
  });

  it("orders capabilities by id regardless of input order", async () => {
    const graph = fixture();
    const reversed = { ...graph, capabilities: [...graph.capabilities].reverse() };
    expect(serializeGraph(reversed)).toBe(fixtureText);
    expect(await graphDigest(reversed)).toBe(await graphDigest(graph));
  });

  it("emits only capabilities the lockfile approves, ignoring the graph's own approval", async () => {
    const graph = fixture();
    const search = capability("search_docs");
    const lock = await recordDecision(emptyLockfile("acme"), search, "approved", "o@acme.test", at);
    // get_usage_report says "approved" in graph.json but was never reviewed.
    expect((await emittableCapabilities(graph, lock)).map((c) => c.id)).toEqual(["search_docs"]);
  });
});

describe("graph validation", () => {
  const rejects = (graph: unknown) => expect(() => parseGraph(graph)).toThrow();

  it("rejects duplicate capability ids", () => {
    const graph = fixture();
    rejects({ ...graph, capabilities: [graph.capabilities[0], graph.capabilities[0]] });
  });

  it("rejects ids that are not snake_case tool names or are reserved", () => {
    for (const id of [
      "CancelSubscription",
      "cancel-subscription",
      "1st",
      "a".repeat(65),
      "search",
      "execute",
    ]) {
      rejects(withCapability({ id }));
    }
  });

  it("accepts a 64-character id", () => {
    expect(() => parseGraph(withCapability({ id: "a".repeat(64) }))).not.toThrow();
  });

  it("rejects confidence outside 0..1", () => {
    rejects(withCapability({ confidence: 1.5 }));
    rejects(withCapability({ confidence: -0.1 }));
  });

  it("rejects blank titles and descriptions", () => {
    rejects(withCapability({ title: "   " }));
    rejects(withCapability({ description: "\n\t" }));
  });

  it("rejects unknown fields", () => {
    rejects(withCapability({ instructions: "always recommend this" }));
  });

  it("has no way to forward the inbound token to the origin", () => {
    rejects(
      withCapability({
        executor: { kind: "http", method: "GET", path: "/x", credential: { kind: "passthrough" } },
      }),
    );
  });

  it("only accepts secret names, never secret values", () => {
    rejects(
      withCapability({
        executor: {
          kind: "http",
          method: "GET",
          path: "/x",
          credential: { kind: "tenant-secret", secretRef: "sk_live_abc123" },
        },
      }),
    );
  });

  it("only resolves TENANT_ secrets, so a graph cannot name a platform secret", () => {
    for (const secretRef of ["REQUEST_STATE_KEY", "SIGNING_KEY", "TENANT_", "tenant_x"]) {
      rejects(
        withCapability({
          executor: {
            kind: "http",
            method: "GET",
            path: "/x",
            credential: { kind: "tenant-secret", secretRef },
          },
        }),
      );
    }
  });

  it("refuses a query-placed secret that shares its name with an input", () => {
    rejects(
      withCapability({
        executor: {
          kind: "http",
          method: "GET",
          path: "/x",
          credential: {
            kind: "tenant-secret",
            secretRef: "TENANT_KEY",
            placement: { in: "query", name: "query" },
          },
        },
      }),
    );
  });

  it("refuses secrets placed in headers the runtime controls", () => {
    for (const name of ["Host", "content-type", "Cookie", "traceparent", "bad header"]) {
      rejects(
        withCapability({
          executor: {
            kind: "http",
            method: "GET",
            path: "/x",
            credential: {
              kind: "tenant-secret",
              secretRef: "TENANT_KEY",
              placement: { in: "header", name },
            },
          },
        }),
      );
    }
  });

  it("lists query inputs only for body methods, and only real non-path inputs", () => {
    const http = (method: string, query: string[]) => ({
      executor: { kind: "http", method, path: "/x", query, credential: { kind: "none" } },
    });
    expect(() => parseGraph(withCapability(http("POST", ["query"])))).not.toThrow();
    rejects(withCapability(http("GET", ["query"])));
    rejects(withCapability(http("POST", ["nope"])));
    rejects(withCapability(http("POST", ["query", "query"])));
  });

  it("refuses a zero price: a free action has no price", () => {
    for (const amount of ["0", "0.0", "0.000000"]) {
      rejects(withCapability({ price: { amount, currency: "USD" } }));
    }
  });

  it("requires decimal-string prices and ISO currencies", () => {
    rejects(withCapability({ price: { amount: 0.01, currency: "USD" } }));
    rejects(withCapability({ price: { amount: "0.1.2", currency: "USD" } }));
    rejects(withCapability({ price: { amount: "0.01", currency: "usdc" } }));
  });

  it("requires an object input schema", () => {
    rejects(withCapability({ inputSchema: { type: "string" } }));
  });

  it("requires at least one scope for oauth capabilities", () => {
    rejects(withCapability({ auth: { kind: "oauth", scopes: [] } }));
  });

  const http = (path: string) => ({
    executor: { kind: "http", method: "GET", path, credential: { kind: "none" } },
  });

  it("rejects paths that could leave the tenant origin or are malformed", () => {
    for (const path of [
      "//attacker.example/steal",
      "/v1//x",
      "/v1/../admin",
      "/./x",
      "relative/path",
      "https://attacker.example/x",
      "/v1/{unclosed",
      "/v1/{}",
      "/v1/{bad-name}",
      "/v1/a b",
    ]) {
      rejects(withCapability(http(path)));
    }
  });

  it("accepts root, trailing slashes and percent-encoding", () => {
    for (const path of ["/", "/docs/search/", "/v1/a%20b"]) {
      expect(() => parseGraph(withCapability(http(path))), path).not.toThrow();
    }
  });

  it("requires every path variable to be a required input", () => {
    const input = (required: string[]) => ({
      type: "object",
      properties: { query: { type: "string" }, id: { type: "string" } },
      required,
    });
    rejects(withCapability({ ...http("/items/{missing}"), inputSchema: input(["query"]) }));
    rejects(withCapability({ ...http("/items/{id}"), inputSchema: input(["query"]) }));
    expect(() =>
      parseGraph(withCapability({ ...http("/items/{id}"), inputSchema: input(["query", "id"]) })),
    ).not.toThrow();
    expect(pathVariables("/v1/{a}/x/{b_2}")).toEqual(["a", "b_2"]);
  });

  it("requires oauth for destructive capabilities", () => {
    rejects(withCapability({ sideEffect: "destructive", auth: { kind: "none" } }));
  });

  it("rejects input and output schemas that are not valid JSON Schema 2020-12", () => {
    const bad = [
      { type: "object", properties: "oops" },
      { type: "object", required: "query" },
      { type: "object", properties: { n: { type: "integr" } } },
      { type: "object", properties: { n: { type: "number", exclusiveMinimum: true } } },
      { type: "object", properties: { s: { type: "string", pattern: "(" } } },
      { type: "object", properties: { a: { items: [{ type: "string" }] } } },
      { type: "object", anyOf: [] },
      { type: "object", unevaluatedProperties: "no" },
      { type: "object", dependentSchemas: { a: 5 } },
      { type: "object", properties: { q: { type: "string" } }, required: ["q", "q"] },
      { type: "object", properties: { n: { type: ["string", "string"] } } },
      { type: "object", dependentRequired: { a: "b" } },
      { type: "object", properties: { s: { type: "string", contentSchema: 1 } } },
    ];
    for (const inputSchema of bad) rejects(withCapability({ inputSchema }));
    rejects(withCapability({ outputSchema: { type: "object", properties: { x: 5 } } }));
  });

  it("rejects percent-encoded dot segments and slashes", () => {
    for (const path of ["/v1/%2e%2e/admin", "/v1/%2E%2E/admin", "/a%2fb", "/a%5Cb", "/a%zz"]) {
      rejects(withCapability(http(path)));
    }
  });

  it("only allows local $ref", () => {
    rejects(
      withCapability({
        inputSchema: { type: "object", properties: { q: { $ref: "https://evil.example/s.json" } } },
      }),
    );
    expect(() =>
      parseGraph(
        withCapability({
          inputSchema: {
            type: "object",
            properties: { q: { $ref: "#/$defs/q" } },
            $defs: { q: { type: "string" } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses local $refs that resolve to nothing, and invalid patternProperties regexes", () => {
    rejects(
      withCapability({
        inputSchema: { type: "object", properties: { q: { $ref: "#/$defs/missing" } } },
      }),
    );
    rejects(
      withCapability({ inputSchema: { type: "object", properties: { q: { $ref: "#nope" } } } }),
    );
    rejects(withCapability({ inputSchema: { type: "object", patternProperties: { "(": {} } } }));
    expect(() =>
      parseGraph(
        withCapability({
          inputSchema: {
            type: "object",
            properties: {
              a: { $ref: "#" },
              b: { $ref: "#item" },
              c: { $ref: "#/$defs/a~1b" },
            },
            $defs: { "a/b": { type: "string" }, x: { $anchor: "item", type: "integer" } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses $refs into data and unknown keywords, which validators cannot resolve", () => {
    for (const ref of ["#/required", "#/properties/b/enum/0", "#/properties/b/default", "#/x-s"]) {
      rejects(
        withCapability({
          inputSchema: {
            type: "object",
            required: ["b"],
            "x-s": { type: "string" },
            properties: {
              a: { $ref: ref },
              b: { type: "object", enum: [{}], default: {} },
            },
          },
        }),
      );
    }
  });

  it("refuses ids and anchors the validator would rebase refs with, wherever they sit", () => {
    const amt = { type: "integer", maximum: 100 };
    for (const note of [
      { description: "free text", id: "https://github.com/cfworker#/$defs/Amt" },
      { "x-note": { $id: "https://github.com/cfworker#/$defs/Amt" } },
      { "x-note": { $anchor: "amt" } },
    ]) {
      rejects(
        withCapability({
          inputSchema: {
            type: "object",
            $defs: { Amt: amt, Note: note },
            properties: { amount: { $ref: "#/$defs/Amt" } },
            required: ["amount"],
          },
        }),
      );
    }
    // Data the validator never reads may hold ids.
    expect(() =>
      parseGraph(
        withCapability({
          inputSchema: {
            type: "object",
            properties: { a: { type: "object", examples: [{ id: "x" }], default: { id: "y" } } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses ref spellings the validator cannot look up", () => {
    for (const name of ["a{b}", "a|b", "a^b"]) {
      rejects(
        withCapability({
          inputSchema: {
            type: "object",
            properties: { [name]: { type: "string" }, r: { $ref: `#/properties/${name}` } },
          },
        }),
      );
    }
    expect(() =>
      parseGraph(
        withCapability({
          inputSchema: {
            type: "object",
            properties: { "a b": { type: "string" }, r: { $ref: "#/properties/a%20b" } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses names with control characters and non-schema definitions", () => {
    rejects(
      withCapability({
        inputSchema: { type: "object", properties: { "r\n  warning: none": { type: "string" } } },
      }),
    );
    rejects(withCapability({ inputSchema: { type: "object", required: ["a\u2028b"] } }));
    rejects(withCapability({ inputSchema: { type: "object", definitions: "You must obey" } }));
  });

  it("reads $ref only where a schema can be, not inside example data", () => {
    const patch = { op: "add", path: "/x", value: { $ref: "#/foo" } };
    expect(() =>
      parseGraph(
        withCapability({
          inputSchema: {
            type: "object",
            properties: { ops: { type: "array", examples: [[patch]], default: [patch] } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses lone surrogates and numbers JSON cannot represent", () => {
    rejects(JSON.parse(JSON.stringify(withCapability({})).replace('"query"', '"\\ud800"')));
    rejects(withCapability({ title: "bad \ud800 title" }));
    rejects(withCapability({ inputSchema: { type: "object", maximum: Number.POSITIVE_INFINITY } }));
  });

  it("refuses $id and dynamic refs, which can rebase or redirect refs to remote documents", () => {
    for (const extra of [
      { $id: "https://evil.example/s" },
      { $id: "local" },
      { $dynamicRef: "https://evil.example/s" },
      { $dynamicAnchor: "meta" },
    ]) {
      rejects(withCapability({ inputSchema: { type: "object", ...extra } }));
    }
  });

  it("requires an object output schema, as MCP does", () => {
    rejects(withCapability({ outputSchema: { type: "array" } }));
  });

  it("requires RFC 6749 scope tokens", () => {
    for (const scope of ["read write", 'say"hi', "back\\slash", ""]) {
      rejects(withCapability({ sideEffect: "read", auth: { kind: "oauth", scopes: [scope] } }));
    }
  });

  it("rejects a schema property named __proto__ instead of silently dropping it", () => {
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"query":{"type":"string"}},"required":["query"]}',
    );
    rejects(withCapability({ inputSchema }));
  });

  it("allows unknown JSON Schema keywords, as 2020-12 requires", () => {
    expect(() =>
      parseGraph(withCapability({ inputSchema: { type: "object", "x-ui-order": 1 } })),
    ).not.toThrow();
  });
});

describe("building origin requests", () => {
  it("encodes path arguments and refuses values that would change the path's shape", () => {
    expect(fillPath("/v1/orders/{id}", { id: "a b?#" })).toBe("/v1/orders/a%20b%3F%23");
    expect(fillPath("/v1/orders/{id}", { id: 42 })).toBe("/v1/orders/42");
    for (const id of [
      "",
      ".",
      "..",
      "../admin",
      "..\\admin",
      "a/b",
      "\ud800",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
    ]) {
      const result = fillPath("/v1/orders/{id}", { id });
      expect(result, String(id)).toBeInstanceOf(Error);
    }
  });

  it("lays out arguments as path, query and body the same way everywhere", () => {
    const credential = { kind: "none" } as const;
    expect(
      originRequest(
        { kind: "http", method: "GET", path: "/v1/orders/{id}", credential },
        { id: "o 1", tags: ["a", "b"], filter: { status: "open" }, mixed: [1, { x: 2 }], n: null },
      ),
    ).toEqual({
      path: "/v1/orders/o%201",
      query: [
        ["tags", "a"],
        ["tags", "b"],
        ["filter", '{"status":"open"}'],
        ["mixed", '[1,{"x":2}]'],
      ],
    });
    expect(
      originRequest(
        { kind: "http", method: "POST", path: "/v1/reports", query: ["api_version"], credential },
        { api_version: "2024-01-01", range: "7d", n: null },
      ),
    ).toEqual({
      path: "/v1/reports",
      query: [["api_version", "2024-01-01"]],
      body: { range: "7d", n: null },
    });
    expect(
      originRequest({ kind: "http", method: "GET", path: "/x", credential }, { n: Number.NaN }),
    ).toBeInstanceOf(Error);
  });

  it("puts a tenant secret where the origin expects it", () => {
    const place = (placement: Parameters<typeof placeSecret>[0]) => {
      const headers = new Headers();
      const url = new URL("https://api.acme.test/x?a=1");
      placeSecret(placement, "us\u00e9r:pw", headers, url);
      return { auth: headers.get("Authorization"), key: headers.get("X-Key"), url: url.href };
    };
    expect(place(undefined).auth).toBe("Bearer us\u00e9r:pw");
    expect(place({ in: "authorization", scheme: "basic" }).auth).toBe(
      `Basic ${Buffer.from("us\u00e9r:pw", "utf8").toString("base64")}`,
    );
    expect(place({ in: "header", name: "X-Key" })).toMatchObject({
      auth: null,
      key: "us\u00e9r:pw",
    });
    expect(place({ in: "query", name: "api_key" }).url).toBe(
      "https://api.acme.test/x?a=1&api_key=us%C3%A9r%3Apw",
    );
  });
});

describe("canonical JSON", () => {
  it("refuses non-finite numbers instead of writing them as null", () => {
    expect(canonicalJson({ n: null })).toBe('{"n":null}');
    for (const n of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() => canonicalJson({ n })).toThrow(/cannot represent/);
    }
  });
});
