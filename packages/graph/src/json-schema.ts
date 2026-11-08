// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Lockfile } from "./lockfile.ts";
import { Graph } from "./schema.ts";

const options = { target: "draft-2020-12", io: "input" } as const;

/** JSON Schema 2020-12 for a capability graph file. */
export function graphJsonSchema(): Record<string, unknown> {
  return { ...z.toJSONSchema(Graph, options), title: "Kapabl capability graph" };
}

/** JSON Schema 2020-12 for capabilities.lock.json. */
export function lockfileJsonSchema(): Record<string, unknown> {
  return { ...z.toJSONSchema(Lockfile, options), title: "Kapabl capabilities lockfile" };
}
