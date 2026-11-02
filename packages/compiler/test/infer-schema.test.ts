// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { inferParamSchema, inferSchema } from "../src/infer-schema.ts";

describe("inferSchema", () => {
  it("merges objects: union of keys, required only when every sample had the key", () => {
    expect(inferSchema([{ a: 1, b: "x" }, { a: 2 }])).toEqual({
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "string" } },
      required: ["a"],
    });
  });

  it("widens integer + number to number and keeps real unions sorted", () => {
    expect(inferSchema([1, 2.5])).toEqual({ type: "number" });
    expect(inferSchema(["a", null])).toEqual({ type: ["null", "string"] });
  });

  it("infers array items from every item of every sample", () => {
    expect(inferSchema([[{ id: 1 }], [{ id: 2, note: "x" }], []])).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, note: { type: "string" } },
        required: ["id"],
      },
    });
    expect(inferSchema([[]])).toEqual({ type: "array", items: {} });
  });

  it("detects date and date-time strings only when every value matches", () => {
    expect(inferSchema(["2026-10-30T12:00:00Z", "2026-10-31T00:00:00.5+05:30"])).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(inferSchema(["2026-10-30"])).toEqual({ type: "string", format: "date" });
    expect(inferSchema(["2026-10-30", "soon"])).toEqual({ type: "string" });
    // RFC 3339 needs seconds and a zone with a colon.
    expect(inferSchema(["2026-10-30T12:30Z"])).toEqual({ type: "string" });
    expect(inferSchema(["2026-10-30T12:30:00+0530"])).toEqual({ type: "string" });
  });

  it("returns an empty schema for no samples and stops at the depth limit", () => {
    expect(inferSchema([])).toEqual({});
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { x: deep };
    let schema = inferSchema([deep]);
    let depth = 0;
    while (schema.properties) {
      schema = (schema.properties as { x: Record<string, unknown> }).x;
      depth++;
    }
    expect(depth).toBe(9);
    expect(schema).toEqual({});
  });
});

describe("inferParamSchema", () => {
  it.each([
    [["1", "20"], { type: "integer" }],
    [["1.5", "2"], { type: "number" }],
    [["true", "false"], { type: "boolean" }],
    [["2026-10-30"], { type: "string", format: "date" }],
    [["paid"], { type: "string" }],
    [["00501", "94107"], { type: "string" }],
    [["12345678901234567890"], { type: "string" }],
    [["0.5", "-3"], { type: "number" }],
    [[], { type: "string" }],
  ])("%j → %j", (values, schema) => {
    expect(inferParamSchema(values)).toEqual(schema);
  });
});
