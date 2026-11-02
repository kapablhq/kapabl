// SPDX-License-Identifier: Apache-2.0
// The MCP tool surface, as data (AGENTS.md M5). Read capabilities sit behind `search` and
// `execute`; every write or destructive capability is its own tool with destructiveHint,
// so hosts can ask the user first. `individual` lists every capability as its own tool
// (`?mode=tools`). The edge registers these definitions with the MCP SDK.

import type { Capability } from "@kapabl/graph";
import { z } from "zod";

export const ToolTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("search") }),
  z.strictObject({ kind: z.literal("execute") }),
  z.strictObject({ kind: z.literal("capability"), id: z.string() }),
]);

export const ToolDef = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.strictObject({
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    idempotentHint: z.boolean(),
    openWorldHint: z.boolean(),
  }),
  target: ToolTarget,
});

export const ToolSurface = z.strictObject({
  /** Default surface: `search`, `execute`, then one tool per write/destructive capability. */
  default: z.array(ToolDef),
  /** `?mode=tools`: one tool per capability, reads included. */
  individual: z.array(ToolDef),
});

export type ToolDef = z.infer<typeof ToolDef>;
export type ToolSurface = z.infer<typeof ToolSurface>;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: 200,
      description: "Words matched against action ids, titles and descriptions. Empty lists all.",
    },
  },
  additionalProperties: false,
};

export const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          signIn: { type: "boolean" },
          inputSchema: { type: "object" },
        },
        required: ["id", "title", "description", "signIn", "inputSchema"],
      },
    },
  },
  required: ["actions"],
};

function executeInputSchema(readIds: readonly string[]) {
  return {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "Id of a read-only action listed by the search tool.",
        ...(readIds.length > 0 ? { enum: [...readIds] } : {}),
      },
      arguments: {
        type: "object",
        description: "Arguments matching that action's input schema.",
      },
    },
    required: ["capability"],
    additionalProperties: false,
  };
}

function capabilityTool(capability: Capability): ToolDef {
  const read = capability.sideEffect === "read";
  const idempotent =
    read ||
    (capability.executor.kind === "http" && ["PUT", "DELETE"].includes(capability.executor.method));
  return {
    name: capability.id,
    title: capability.title,
    description: capability.price
      ? `${capability.description}\n\nPrice: ${capability.price.amount} ${capability.price.currency} per call.`
      : capability.description,
    inputSchema: capability.inputSchema,
    ...(capability.outputSchema ? { outputSchema: capability.outputSchema } : {}),
    annotations: read
      ? READ_ONLY
      : {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: idempotent,
          openWorldHint: false,
        },
    target: { kind: "capability", id: capability.id },
  };
}

/**
 * Whether a capability is its own tool on the default surface: writes and destructive
 * actions (so hosts can ask first), and priced reads (so the price shows before the call).
 */
export function ownTool(capability: Capability): boolean {
  return capability.sideEffect !== "read" || capability.price !== undefined;
}

/** Tool definitions for approved capabilities, sorted by name (deterministic tools/list). */
export function mcpTools(capabilities: readonly Capability[]): ToolSurface {
  const sorted = [...capabilities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reads = sorted.filter((c) => !ownTool(c));
  const search: ToolDef = {
    name: "search",
    title: "Search actions",
    description:
      "Lists the read-only actions this site publishes, with their input schemas. The query is matched against action ids, titles and descriptions.",
    inputSchema: SEARCH_INPUT_SCHEMA,
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    annotations: READ_ONLY,
    target: { kind: "search" },
  };
  const execute: ToolDef = {
    name: "execute",
    title: "Run a read-only action",
    description: "Runs one read-only action listed by the search tool, with matching arguments.",
    inputSchema: executeInputSchema(reads.map((c) => c.id)),
    annotations: { ...READ_ONLY, idempotentHint: false },
    target: { kind: "execute" },
  };
  const own = sorted.filter(ownTool).map(capabilityTool);
  return {
    default: [execute, search, ...own].sort((a, b) => (a.name < b.name ? -1 : 1)),
    individual: sorted.map(capabilityTool),
  };
}
