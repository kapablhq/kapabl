// SPDX-License-Identifier: Apache-2.0
// Regenerates schema/*.schema.json from the Zod source. Never edit those files by hand
// (AGENTS.md D2); a test fails if they drift from the source.

import { mkdirSync, writeFileSync } from "node:fs";
import { prettyCanonicalJson } from "../src/canonical.ts";
import { graphJsonSchema, lockfileJsonSchema } from "../src/json-schema.ts";

const dir = new URL("../schema/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("graph.schema.json", dir), prettyCanonicalJson(graphJsonSchema()));
writeFileSync(new URL("lockfile.schema.json", dir), prettyCanonicalJson(lockfileJsonSchema()));
console.log("wrote schema/graph.schema.json and schema/lockfile.schema.json");
