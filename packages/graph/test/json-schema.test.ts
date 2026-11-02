// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  emptyLockfile,
  graphJsonSchema,
  lockfileJsonSchema,
  parseGraph,
  prettyCanonicalJson,
  recordDecision,
} from "../src/index.ts";

// ajv-formats is CommonJS; its default export arrives wrapped under ESM.
const addFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule;

const fixtureJson = JSON.parse(
  readFileSync(new URL("./fixtures/graph.json", import.meta.url), "utf8"),
);

function ajv() {
  const instance = new Ajv2020({ strict: true, allErrors: true });
  addFormats(instance);
  return instance;
}

describe("JSON Schema 2020-12 output", () => {
  it("is a valid 2020-12 schema", () => {
    for (const schema of [graphJsonSchema(), lockfileJsonSchema()]) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      const validator = ajv();
      expect(validator.validateSchema(schema), JSON.stringify(validator.errors)).toBe(true);
    }
  });

  it("accepts the fixture graph and rejects an invalid one", () => {
    const validate = ajv().compile(graphJsonSchema());
    expect(validate(fixtureJson), JSON.stringify(validate.errors)).toBe(true);
    const bad = structuredClone(fixtureJson);
    bad.capabilities[0].confidence = 2;
    expect(validate(bad)).toBe(false);
  });

  it("carries the security rules that JSON Schema can express", () => {
    const validate = ajv().compile(graphJsonSchema());
    type Cap = Record<string, unknown> & { executor: Record<string, unknown> };
    const breaks: Array<(c: Cap) => void> = [
      (c) => {
        c.id = "search";
      },
      (c) => {
        c.executor.path = "/v1/../admin";
      },
      (c) => {
        c.executor.path = "/v1/%2e%2e/admin";
      },
      (c) => {
        c.sideEffect = "destructive";
        c.auth = { kind: "none" };
      },
      (c) => {
        c.price = { amount: "0.00", currency: "USD" };
      },
      (c) => {
        c.executor.credential = { kind: "tenant-secret", secretRef: "REQUEST_STATE_KEY" };
      },
    ];
    for (const breakIt of breaks) {
      const bad = structuredClone(fixtureJson);
      breakIt(bad.capabilities[0]);
      expect(() => parseGraph(bad)).toThrow();
      expect(validate(bad), JSON.stringify(bad.capabilities[0])).toBe(false);
    }
  });

  it("agrees with the Zod parser on a generated lockfile", async () => {
    const graph = parseGraph(fixtureJson);
    const [first] = graph.capabilities;
    if (!first) throw new Error("empty fixture");
    const lock = await recordDecision(
      emptyLockfile("acme"),
      first,
      "approved",
      "owner@acme.test",
      new Date(),
    );
    const validate = ajv().compile(lockfileJsonSchema());
    expect(validate(JSON.parse(JSON.stringify(lock))), JSON.stringify(validate.errors)).toBe(true);
  });

  it("each capability's input and output schema is itself valid 2020-12", () => {
    for (const c of parseGraph(fixtureJson).capabilities) {
      for (const schema of [c.inputSchema, c.outputSchema].filter(Boolean)) {
        const validator = ajv();
        expect(
          validator.validateSchema(schema as object),
          `${c.id}: ${JSON.stringify(validator.errors)}`,
        ).toBe(true);
      }
    }
  });

  it("matches the committed schema files (run `pnpm schemas` after changing the source)", () => {
    const read = (name: string) =>
      readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8");
    expect(read("graph.schema.json")).toBe(prettyCanonicalJson(graphJsonSchema()));
    expect(read("lockfile.schema.json")).toBe(prettyCanonicalJson(lockfileJsonSchema()));
  });
});
