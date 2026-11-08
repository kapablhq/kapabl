// SPDX-License-Identifier: Apache-2.0
// Contract tests for approved http capabilities (AGENTS.md H4). The owner keeps one small
// file, kapabl.contracts.json, holding example arguments per capability. Everything the
// test checks (method, path, expected response schema) comes from the graph at run time,
// so a contract can never drift from what agents are actually offered.
//
// By default only reads run. Writes run with `includeWrites`. Destructive actions never
// run from a contract test: refunding or deleting something in CI is not a test. Requests
// are built and answers read by the same code the edge uses (@kapabl/graph origin.ts).

import {
  BODY_METHODS,
  type Capability,
  DEFAULT_ORIGIN_TIMEOUT_MS,
  originRequest,
  placeSecret,
  readLimited,
} from "@kapabl/graph";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";

export const CONTRACTS_FORMAT_VERSION = 1;

export const ContractsFile = z.strictObject({
  contractsVersion: z.literal(CONTRACTS_FORMAT_VERSION),
  /** Where contracts run by default; `kapabl test --api-origin` points them at staging. */
  apiOrigin: z.url({ protocol: /^https?$/ }),
  /** Capability id → arguments to call it with. */
  examples: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export type ContractsFile = z.infer<typeof ContractsFile>;

export interface ContractResult {
  id: string;
  outcome: "pass" | "fail" | "skip";
  detail: string;
}

export interface ContractOptions {
  apiOrigin: string;
  fetch?: typeof fetch;
  /**
   * `Authorization` value for capabilities that call the API as the signed-in user (token
   * exchange): a test user's token. Never logged.
   */
  authorization?: string | undefined;
  /** Tenant secrets by name (`TENANT_*`), for capabilities that call with one. Never logged. */
  secrets?: Readonly<Record<string, string | undefined>>;
  includeWrites?: boolean;
  /** Overrides each capability's own `timeoutMs`. */
  timeoutMs?: number;
}

/** A read by label and by method, the same test `runOne` applies before running anything. */
function isRead(capability: Capability): boolean {
  return (
    capability.executor.kind === "http" &&
    capability.sideEffect === "read" &&
    !BODY_METHODS.has(capability.executor.method) &&
    capability.executor.method !== "DELETE"
  );
}

/** A read that needs no arguments, so it can run without an example. */
function runsWithoutArguments(capability: Capability): boolean {
  return isRead(capability) && ((capability.inputSchema.required ?? []) as string[]).length === 0;
}

/**
 * Arguments built from the input schema's own `examples` (an OpenAPI document's `example`
 * values are carried there): the first example of every property that has one, nested
 * objects included. Undefined unless every required property got one and the result
 * matches the schema.
 */
export function schemaExample(capability: Capability): Record<string, unknown> | undefined {
  const build = (schema: unknown, depth: number): unknown => {
    if (schema === null || typeof schema !== "object" || depth > 8) return undefined;
    const node = schema as Record<string, unknown>;
    if (Array.isArray(node.examples) && node.examples.length > 0) return node.examples[0];
    if (node.const !== undefined) return node.const;
    if (node.type !== "object" || typeof node.properties !== "object" || !node.properties)
      return undefined;
    const out: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(node.properties as Record<string, unknown>)) {
      const value = build(sub, depth + 1);
      if (value !== undefined) out[name] = value;
    }
    const required = (Array.isArray(node.required) ? node.required : []) as string[];
    return required.every((name) => Object.hasOwn(out, name)) ? out : undefined;
  };
  const args = build(capability.inputSchema, 0);
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  return checkExample(capability, args as Record<string, unknown>) === undefined
    ? (args as Record<string, unknown>)
    : undefined;
}

/** Why `args` cannot be this capability's example, or undefined when they fit its input schema. */
export function checkExample(
  capability: Capability,
  args: Record<string, unknown>,
): string | undefined {
  const validate = newAjv().compile(capability.inputSchema as object);
  return validate(args) ? undefined : describeErrors(validate);
}

/**
 * The contracts file after a compile: the owner's examples are kept, new capabilities get
 * the compiler's examples, and removed ones are dropped. An empty example counts as none,
 * so a later capture can fill it in. With no example at all, a read gets one built from
 * its schema's examples, or runs without arguments when it needs none; anything else
 * waits for the owner (`kapabl example`), because calling a write with arguments nobody
 * chose (`PUT /settings {}`) can undo real data.
 */
export function updateContracts(
  previous: ContractsFile | undefined,
  apiOrigin: string,
  capabilities: readonly Capability[],
  examples: Readonly<Record<string, Record<string, unknown>>> = {},
): ContractsFile {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of [...capabilities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (c.executor.kind !== "http") continue;
    const kept = previous?.examples[c.id];
    const example =
      [kept, examples[c.id]].find((e) => e !== undefined && Object.keys(e).length > 0) ??
      (isRead(c) ? schemaExample(c) : undefined) ??
      kept ??
      (runsWithoutArguments(c) ? {} : undefined);
    if (example !== undefined) out[c.id] = example;
  }
  return {
    contractsVersion: CONTRACTS_FORMAT_VERSION,
    apiOrigin: previous?.apiOrigin ?? new URL(apiOrigin).origin,
    examples: out,
  };
}

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

function describeErrors(validate: ValidateFunction): string {
  const first = validate.errors?.[0];
  return first ? `${first.instancePath || "/"} ${first.message ?? "is invalid"}` : "is invalid";
}

async function runOne(
  capability: Capability,
  args: Record<string, unknown> | undefined,
  options: ContractOptions,
  ajv: Ajv2020,
): Promise<ContractResult> {
  const result = (outcome: ContractResult["outcome"], detail: string): ContractResult => ({
    id: capability.id,
    outcome,
    detail,
  });
  const executor = capability.executor;
  if (executor.kind !== "http") return result("skip", "not an http capability");
  // The method decides as much as the label: a DELETE relabeled as a read still never
  // runs, and a POST, PUT or PATCH changes something until the owner says it may run.
  if (capability.sideEffect === "destructive" || executor.method === "DELETE")
    return result("skip", "destructive actions are never run by contract tests");
  if (
    (capability.sideEffect === "write" || BODY_METHODS.has(executor.method)) &&
    !options.includeWrites
  )
    return result("skip", "writes run only with --include-writes");
  if (args === undefined) return result("skip", "no example arguments in the contracts file");
  const credential = executor.credential;
  const secret =
    credential.kind === "tenant-secret" ? options.secrets?.[credential.secretRef] : undefined;
  if (credential.kind === "tenant-secret" && !secret)
    return result("skip", `needs the site's credential: set ${credential.secretRef}`);
  if (credential.kind === "token-exchange" && !options.authorization)
    return result("skip", "needs a signed-in user's token: set KAPABL_CONTRACT_AUTHORIZATION");

  const validateInput = ajv.compile(capability.inputSchema as object);
  if (!validateInput(args))
    return result(
      "fail",
      `example arguments do not match the input schema: ${describeErrors(validateInput)}`,
    );
  const request = originRequest(executor, args);
  if (request instanceof Error) return result("fail", `example ${request.message}`);
  const url = new URL(request.path, options.apiOrigin);
  if (url.origin !== new URL(options.apiOrigin).origin)
    return result("fail", "the request would leave the API origin");
  for (const [name, value] of request.query) url.searchParams.append(name, value);

  const headers = new Headers({ Accept: "application/json" });
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  if (secret)
    placeSecret(
      credential.kind === "tenant-secret" ? credential.placement : undefined,
      secret,
      headers,
      url,
    );
  else if (credential.kind === "token-exchange" && options.authorization)
    headers.set("Authorization", options.authorization);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: executor.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(
        options.timeoutMs ?? executor.timeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    return result(
      "fail",
      `request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const label = `${executor.method} ${executor.path} → ${response.status}`;
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    return result("fail", `${label}, expected 2xx`);
  }
  // Read as the edge reads it: a body the edge would refuse fails here too.
  const text = await readLimited(response);
  if (text instanceof Error) return result("fail", `${label}, but ${text.message}`);
  // Every capability answers JSON or nothing: a 2xx sign-in page is not the API answering.
  const type = response.headers.get("Content-Type") ?? "";
  if ((capability.outputSchema || text.trim() !== "") && !/\bjson\b/i.test(type))
    return result("fail", `${label}, but the Content-Type is ${type || "missing"}, not JSON`);
  if (!capability.outputSchema) return result("pass", label);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return result("fail", `${label}, but the body is not JSON`);
  }
  // Tool results carry an object; the edge cannot return anything else as structured output.
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return result("fail", `${label}, but the body is not a JSON object`);
  const validateOutput = ajv.compile(capability.outputSchema as object);
  if (!validateOutput(body))
    return result("fail", `${label}, response ${describeErrors(validateOutput)}`);
  return result("pass", label);
}

/** Run every approved http capability's contract, one at a time, in id order. */
export async function runContracts(
  capabilities: readonly Capability[],
  contracts: ContractsFile,
  options: ContractOptions,
): Promise<ContractResult[]> {
  const ajv = newAjv();
  const results: ContractResult[] = [];
  for (const capability of [...capabilities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (capability.approval !== "approved") continue;
    results.push(await runOne(capability, contracts.examples[capability.id], options, ajv));
  }
  return results;
}
