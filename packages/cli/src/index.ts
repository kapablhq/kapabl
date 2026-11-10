// SPDX-License-Identifier: Apache-2.0
// @kapabl/cli: compile sources into the capability graph, review it, test it, emit it.
//
//   kapabl compile --har capture.har [--api-origin URL] --tenant acme
//   kapabl compile --openapi openapi.yaml [--api-origin URL] --tenant acme
//   kapabl review [--approve id,..|--approve-all] [--reject id,..] [--by name]
//                 [--price id=0.01USD|id=none] [--side-effect id=read|write|destructive]
//   kapabl example id '{"arg": 1}'
//   kapabl audit --har capture.har | --openapi openapi.yaml [--out audit.html]
//   kapabl audit --site https://example.com [--category personal] [--out audit.html]
//   kapabl test [--api-origin URL] [--include-writes]
//   kapabl emit --openapi out.json [--title T] [--version V]
//
// Project files live in ./kapabl (override with --dir): graph.json, the owner's
// capabilities.lock.json, and contracts.json. A raw HAR is read, scrubbed in memory
// (AGENTS.md H1) and never written anywhere.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ContractsFile,
  checkExample,
  compileHar,
  importOpenApi,
  mergeCapabilities,
  runContracts,
  updateContracts,
} from "@kapabl/compiler";
import { openApiDocument } from "@kapabl/emitters";
import {
  applyLockfile,
  type Capability,
  emittableCapabilities,
  emptyLockfile,
  type Graph,
  type Lockfile,
  Price,
  parseGraph,
  parseLockfile,
  prettyCanonicalJson,
  recordDecision,
  SideEffect,
  SUBSCHEMA_LIST,
  SUBSCHEMA_MAP,
  SUBSCHEMA_ONE,
  serializeGraph,
  serializeLockfile,
} from "@kapabl/graph";
import { auditHtml, siteAuditHtml } from "./audit.ts";
import { RADAR, SITE_CHECKS, type SiteCategory } from "./benchmarks.ts";
import { credentialText, printable } from "./text.ts";

export interface Io {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  /** Ask one question and return the answer. Absent when not interactive. */
  ask?: ((question: string) => Promise<string>) | undefined;
  fetch?: typeof fetch;
}

const USAGE = `Usage: kapabl <command> [options]

Commands:
  compile --har FILE | --openapi FILE  Add capabilities to the graph (pending review)
          --tenant ID                  Tenant id (required for a new graph)
          [--api-origin URL]           API origin (default: from the source)
  review  [--approve IDS] [--approve-all] [--reject IDS] [--by NAME]
                                       Approve or reject pending capabilities
          [--price ID=0.01USD|ID=none] Set or remove a per-call price
          [--side-effect ID=read|write|destructive]
                                       Correct what an action does
                                       (a change needs approving again)
  example ID JSON                      Set the arguments a contract test calls ID with
  audit   --har FILE | --openapi FILE  Write a one-page action audit (HTML); writes
          [--out FILE] [--api-origin URL] nothing else and uploads nothing
          [--cloudflare-level N]       The site's isitagentready.com level, if known
  audit   --site URL [--out FILE]      Write a one-page website audit (HTML) for a site
          [--category NAME]            with no API. Sends the address, and nothing else,
                                       to Cloudflare's scanner. NAME is the kind of site
                                       to compare with: ${Object.keys(RADAR.categories).join(", ")}
  test    [--api-origin URL] [--include-writes]
                                       Run contract tests against the API
  emit    --openapi FILE [--title T] [--version V]
                                       Write an OpenAPI 3.1 document of approved actions

Options:
  --dir DIR   Project directory (default: ./kapabl)`;

class UsageError extends Error {}

/** Parsed options: `--approve` and `--reject` can repeat. */
type Values = Record<string, string | boolean | string[] | undefined>;

interface Project {
  dir: string;
  graphPath: string;
  lockPath: string;
  contractsPath: string;
}

function project(io: Io, dir: string | undefined): Project {
  const root = resolve(io.cwd, dir ?? "kapabl");
  return {
    dir: root,
    graphPath: join(root, "graph.json"),
    lockPath: join(root, "capabilities.lock.json"),
    contractsPath: join(root, "contracts.json"),
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text);
}

async function loadGraph(p: Project): Promise<Graph> {
  const json = await readJson(p.graphPath);
  if (json === undefined)
    throw new UsageError(`no graph at ${p.graphPath}: run "kapabl compile" first`);
  return parseGraph(json);
}

async function loadLock(p: Project, tenant: string): Promise<Lockfile> {
  const json = await readJson(p.lockPath);
  return json === undefined ? emptyLockfile(tenant) : parseLockfile(json);
}

/** `--approve a,b --approve c` → [a, b, c]. */
function ids(value: string | boolean | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One line per line of text, indented; nothing in it can start a new item. */
function block(label: string, text: string): string[] {
  const lines = printable(text).split("\n");
  return [`  ${label}: ${lines[0]}`, ...lines.slice(1).map((line) => `    ${line}`)];
}

/** A type on one line: a `format` with a newline cannot forge review lines. */
function typeName(schema: unknown): string {
  return rawTypeName(schema).replace(/[\r\n\u2028\u2029]/g, (c) => JSON.stringify(c).slice(1, -1));
}

function rawTypeName(schema: unknown): string {
  if (schema === null || typeof schema !== "object") return schema === false ? "never" : "any";
  const s = schema as { type?: unknown; enum?: unknown[]; items?: unknown; format?: unknown };
  if (Array.isArray(s.enum)) return `one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  const type = Array.isArray(s.type)
    ? s.type.join(" | ")
    : typeof s.type === "string"
      ? s.type
      : "any";
  if (type === "array") return `array of ${rawTypeName(s.items)}`;
  return typeof s.format === "string" ? `${type} (${s.format})` : type;
}

/** Keywords that hold subschemas, walked rather than printed. */
const SUBSCHEMA = new Set<string>([...SUBSCHEMA_ONE, ...SUBSCHEMA_LIST, ...SUBSCHEMA_MAP]);
/** Keywords whose strings are structure, not text: types, required names, pointers. */
const STRUCTURE = new Set(["type", "$ref", "$schema", "$id", "$anchor"]);

/** A name as a path step: plain names as they are, anything else quoted and escaped. */
const step = (name: string) => (/^[\w$-]+$/.test(name) ? name : JSON.stringify(name));

const isSchema = (v: unknown) =>
  typeof v === "boolean" || (v !== null && typeof v === "object" && !Array.isArray(v));

/** Whether a subschema keyword holds the shape `schemaText` walks. */
function schemaShaped(key: string, value: unknown): boolean {
  if ((SUBSCHEMA_LIST as readonly string[]).includes(key))
    return Array.isArray(value) && value.every(isSchema);
  if ((SUBSCHEMA_MAP as readonly string[]).includes(key))
    return (
      isSchema(value) &&
      typeof value !== "boolean" &&
      Object.values(value as object).every(isSchema)
    );
  return isSchema(value);
}

/** Whether a JSON value holds a string anywhere. */
/** Whether a JSON value holds text anywhere: a string, or an object key. */
function hasString(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(hasString);
  if (value !== null && typeof value === "object")
    return Object.keys(value).length > 0 || Object.values(value).some(hasString);
  return false;
}

/** Standard keywords; any other keyword's name is text agents read, whatever its value. */
const KNOWN_KEYWORDS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "const",
  "enum",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "required",
  "dependentRequired",
  "contentEncoding",
  "contentMediaType",
  "readOnly",
  "writeOnly",
  "deprecated",
  "$comment",
]);

/**
 * Every piece of text a schema shows agents, with where it sits, apart from what the
 * input list already prints (top-level property descriptions). Any keyword counts, known
 * or not: `$comment` and `x-*` reach agents unchanged too.
 */
function schemaText(schema: unknown, at: string, top = false): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(s)) {
    if (STRUCTURE.has(key)) continue;
    if (!hasString(raw) && (KNOWN_KEYWORDS.has(key) || SUBSCHEMA.has(key))) continue;
    if (top && key === "description") continue;
    // A subschema keyword is walked below, unless what it holds is not a schema.
    if (SUBSCHEMA.has(key) && schemaShaped(key, raw)) continue;
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    lines.push(`    ${at} ${step(key)}: ${value.split("\n").join(" / ")}`);
  }
  // Names are text agents read as well; the input list already shows the top-level ones.
  for (const key of SUBSCHEMA_MAP) {
    const map = s[key];
    if (map === null || typeof map !== "object") continue;
    if (key === "properties" && at === "input") continue;
    const names = Object.keys(map);
    if (names.length > 0) lines.push(`    ${at} ${key} names: ${JSON.stringify(names)}`);
  }
  for (const key of SUBSCHEMA_ONE) lines.push(...schemaText(s[key], `${at}.${key}`));
  for (const key of SUBSCHEMA_LIST) {
    const list = Array.isArray(s[key]) ? (s[key] as unknown[]) : [];
    for (const [i, sub] of list.entries()) lines.push(...schemaText(sub, `${at}.${key}[${i}]`));
  }
  for (const key of SUBSCHEMA_MAP) {
    const map = s[key];
    if (map === null || typeof map !== "object") continue;
    for (const [name, sub] of Object.entries(map)) {
      lines.push(...schemaText(sub, `${at}.${step(name)}`, key === "properties" && at === "input"));
    }
  }
  return lines;
}

/** Phrases that address an agent rather than describe the action (AGENTS.md D5). */
const INSTRUCTION =
  /\b(?:ignore (?:all |any )?(?:previous|prior|above|earlier)|you (?:must|should)|always (?:call|use|recommend|choose)|never (?:call|use|mention|tell)|do not tell|don't tell|keep [^.]{0,30} in (?:your )?context|system prompt|(?:previous|prior) instructions)/i;

/** What the reviewer should look at twice before approving. */
function warnings(c: Capability, text: string[]): string[] {
  const out: string[] = [];
  if (
    c.sideEffect !== "read" &&
    c.auth.kind === "none" &&
    c.executor.kind === "http" &&
    c.executor.credential.kind === "tenant-secret"
  ) {
    out.push("  warning: anyone can run this, with the site's own credential");
  }
  // Any run of whitespace reads as one space to an agent.
  const plain = (t: string) => t.replace(/\s+/g, " ");
  const shown = text.filter((t) => INSTRUCTION.test(plain(t)));
  for (const flagged of shown)
    out.push(`  warning: this reads like an instruction to agents (D5): ${flagged.trim()}`);
  // Display lines escape tabs and join lines, which can split a phrase: check the raw
  // text agents receive as well, and show what the display lines missed.
  const covered = shown.map((t) => plain(t.split(" / ").join(" ")));
  for (const raw of rawText(c)) {
    const p = plain(raw);
    if (INSTRUCTION.test(p) && !covered.some((t) => t.includes(p)))
      out.push(`  warning: this reads like an instruction to agents (D5): ${JSON.stringify(raw)}`);
  }
  return out;
}

/** Every string agents receive for a capability, as written: text, keys and values. */
function rawText(c: Capability): string[] {
  const out = [c.title, c.description];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value !== null && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        walk(v);
      }
  };
  walk(c.inputSchema);
  walk(c.outputSchema);
  return [...new Set(out)];
}

/** Everything an agent will be shown or a call will do, for the reviewer to approve. */
function describe(c: Capability): string[] {
  const where =
    c.executor.kind === "http" ? `${c.executor.method} ${c.executor.path}` : c.executor.kind;
  const auth = c.auth.kind === "oauth" ? `signed-in user (${c.auth.scopes.join(" ")})` : "anyone";
  const properties = (c.inputSchema.properties ?? {}) as Record<string, { description?: unknown }>;
  const required = new Set((c.inputSchema.required ?? []) as string[]);
  const inQuery = new Set(c.executor.kind === "http" ? (c.executor.query ?? []) : []);
  const inputs = Object.entries(properties).flatMap(([name, schema]) => {
    const flags = [
      typeName(schema),
      required.has(name) ? "required" : "",
      inQuery.has(name) ? "in query" : "",
    ]
      .filter(Boolean)
      .join(", ");
    const head = `    ${printable(name).split("\n").join("\\n")} (${flags})`;
    return typeof schema?.description === "string"
      ? [`${head}: ${printable(schema.description).split("\n").join(" / ")}`]
      : [head];
  });
  const output = c.outputSchema?.properties as Record<string, unknown> | undefined;
  const provenance = c.provenance;
  const extra = [...schemaText(c.inputSchema, "input"), ...schemaText(c.outputSchema, "output")];
  const everything = [c.title, c.description, ...inputs, ...extra];
  return [
    `${c.id}  [${c.sideEffect}]  ${where}`,
    ...block("title", c.title),
    ...block("description", c.description),
    `  who: ${auth}; confidence ${c.confidence}`,
    `  calls the site with: ${credentialText(c)}`,
    ...(c.price ? [`  price: ${c.price.amount} ${c.price.currency} per call`] : []),
    `  inputs:${inputs.length > 0 ? "" : " none"}`,
    ...inputs,
    `  output: ${
      output
        ? Object.entries(output)
            .map(([name, schema]) => `${printable(name)}: ${typeName(schema)}`)
            .join(", ") || "an object"
        : "not described"
    }`,
    ...(extra.length > 0 ? ["  more text agents see:", ...extra] : []),
    `  from: ${provenance.source}${provenance.source === "har" ? ` (${provenance.samples} samples)` : ""}`,
    ...warnings(c, everything),
  ];
}

/** Compile the `--har` or `--openapi` source in memory; nothing is written. */
async function compileSource(
  io: Io,
  values: Values,
): Promise<{
  result: Awaited<ReturnType<typeof importOpenApi>> | Awaited<ReturnType<typeof compileHar>>;
  examples: Record<string, Record<string, unknown>>;
}> {
  const harPath = values.har as string | undefined;
  const openapiPath = values.openapi as string | undefined;
  const apiOrigin = values["api-origin"] as string | undefined;
  const options = apiOrigin ? { apiOrigin } : {};
  let result: Awaited<ReturnType<typeof importOpenApi>> | Awaited<ReturnType<typeof compileHar>>;
  let examples: Record<string, Record<string, unknown>> = {};
  if (harPath) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolve(io.cwd, harPath), "utf8"));
    } catch (error) {
      // The parser's message quotes the file, which is not scrubbed yet (H1).
      if (error instanceof SyntaxError) throw new Error(`${harPath} is not valid JSON`);
      throw error;
    }
    const har = await compileHar(parsed, options);
    const s = har.scrub;
    io.out(
      `Scrubbed ${s.entries} requests (left out ${s.entriesDropped} that were not http): ` +
        `dropped ${s.headersDropped} headers, ${s.queryParamsDropped} sensitive parameters, ` +
        `${s.cookiesDropped} cookies, ${s.bodiesDropped} bodies that were not JSON or form data; ` +
        `redacted ${Object.values(s.redactions).reduce((a, b) => a + (b ?? 0), 0)} values.`,
    );
    examples = har.examples;
    result = har;
  } else {
    try {
      result = await importOpenApi(
        await readFile(resolve(io.cwd, openapiPath as string), "utf8"),
        options,
      );
    } catch (error) {
      // YAML errors quote the source around the problem; the line is enough.
      const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
      if ((error as Error).name === "YAMLParseError")
        throw new Error(`${openapiPath} is not valid YAML or JSON${line ? ` (line ${line})` : ""}`);
      throw error;
    }
  }
  return { result, examples };
}

async function compile(io: Io, values: Values): Promise<number> {
  const p = project(io, values.dir as string | undefined);
  const harPath = values.har as string | undefined;
  const openapiPath = values.openapi as string | undefined;
  if (Boolean(harPath) === Boolean(openapiPath))
    throw new UsageError("compile needs exactly one of --har or --openapi");

  const existing = await readJson(p.graphPath);
  const graph = existing === undefined ? undefined : parseGraph(existing);
  const tenant = (values.tenant as string | undefined) ?? graph?.tenant;
  if (!tenant) throw new UsageError("--tenant is required for a new graph");
  const { result, examples } = await compileSource(io, values);

  // One graph serves one API origin: the edge calls every http capability against it.
  const previousJson = await readJson(p.contractsPath);
  const previous = previousJson === undefined ? undefined : ContractsFile.parse(previousJson);
  if (previous && previous.apiOrigin !== result.apiOrigin) {
    // A capture's requests went where they went; an OpenAPI document's paths can be pointed
    // at another origin.
    throw new UsageError(
      `this project calls ${previous.apiOrigin}, but the source is for ${result.apiOrigin}. ` +
        (harPath
          ? "Use another --dir for a second API."
          : `Use another --dir for a second API, or pass --api-origin ${previous.apiOrigin} if these paths live there.`),
    );
  }
  for (const s of result.skipped) io.out(`  - ${s.method} ${s.path}: ${printable(s.reason)}`);
  if (result.capabilities.length === 0) {
    // Writing an empty or unchanged project would look like success.
    io.err(
      harPath && "origins" in result && result.origins.length > 0
        ? `kapabl: no actions compiled for ${result.apiOrigin}; the capture called ${result.origins.join(", ")}.`
        : `kapabl: no actions compiled for ${result.apiOrigin}.`,
    );
    return 1;
  }
  const merged = mergeCapabilities(graph, tenant, result.capabilities);
  const contracts = updateContracts(
    previous,
    result.apiOrigin,
    merged.graph.capabilities,
    examples,
  );
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.graphPath, serializeGraph(merged.graph));
  await writeFile(p.contractsPath, prettyCanonicalJson(contracts));

  io.out(`API origin: ${result.apiOrigin}`);
  io.out(
    `Added ${merged.added.length}, updated ${merged.updated.length}, unchanged ${merged.unchanged.length}.`,
  );
  for (const id of merged.added) io.out(`  + ${id}`);
  for (const id of merged.updated) io.out(`  ~ ${id}`);
  if (result.skipped.length > 0) io.out(`Skipped ${result.skipped.length} (listed above).`);
  io.out(`Nothing is live until approved: run "kapabl review".`);
  return 0;
}

const ANSWERS: Record<string, "approve" | "reject" | "skip" | "quit" | undefined> = {
  a: "approve",
  approve: "approve",
  r: "reject",
  reject: "reject",
  s: "skip",
  skip: "skip",
  q: "quit",
  quit: "quit",
};

/** `id=value` pairs from repeated flags; one value per id. */
function assignments(flag: string, value: Values[string]): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of Array.isArray(value) ? value : typeof value === "string" ? [value] : []) {
    const at = pair.indexOf("=");
    const id = pair.slice(0, at).trim();
    if (at < 1 || !id) throw new UsageError(`--${flag} takes ID=VALUE, not "${pair}"`);
    if (out.has(id)) throw new UsageError(`--${flag} names "${id}" twice`);
    out.set(id, pair.slice(at + 1).trim());
  }
  return out;
}

/** `0.01USD`, `0.01 USD` or `none`. */
function parsePrice(text: string): Capability["price"] | null {
  if (text === "none") return null;
  const match = /^(\S+?)\s*([A-Z]{3})$/.exec(text);
  const price = Price.safeParse(match ? { amount: match[1], currency: match[2] } : {});
  if (!price.success) throw new UsageError(`--price wants e.g. 0.01USD or none, not "${text}"`);
  return price.data;
}

/**
 * The owner's corrections to the graph, from `--price` and `--side-effect`. They change the
 * capability's digest, so an earlier approval no longer covers it: it needs approving again
 * (AGENTS.md H3), in this same command or a later one.
 */
async function correct(io: Io, p: Project, graph: Graph, values: Values): Promise<Graph> {
  const prices = assignments("price", values.price);
  const effects = assignments("side-effect", values["side-effect"]);
  if (prices.size === 0 && effects.size === 0) return graph;
  const known = new Set(graph.capabilities.map((c) => c.id));
  for (const id of [...prices.keys(), ...effects.keys()])
    if (!known.has(id)) throw new UsageError(`unknown capability "${id}"`);
  const changes: string[] = [];
  const capabilities = graph.capabilities.map((c) => {
    let next: Capability = c;
    const effect = effects.get(c.id);
    if (effect !== undefined) {
      const parsed = SideEffect.safeParse(effect);
      if (!parsed.success)
        throw new UsageError(`--side-effect wants read, write or destructive, not "${effect}"`);
      if (parsed.data !== c.sideEffect) {
        next = { ...next, sideEffect: parsed.data };
        changes.push(`${c.id}: ${c.sideEffect} → ${parsed.data}`);
      }
    }
    const priceText = prices.get(c.id);
    if (priceText !== undefined) {
      const price = parsePrice(priceText);
      const before = c.price ? `${c.price.amount} ${c.price.currency}` : "free";
      const after = price ? `${price.amount} ${price.currency}` : "free";
      if (before !== after) {
        const { price: _old, ...rest } = next;
        next = price ? { ...rest, price } : rest;
        changes.push(`${c.id}: ${before} → ${after} per call`);
      }
    }
    return next;
  });
  if (changes.length === 0) return graph;
  // The graph's own rules still hold: a destructive action anyone may call is refused.
  let updated: Graph;
  try {
    updated = parseGraph({ ...graph, capabilities });
  } catch (error) {
    const issue = (error as { issues?: { message: string; path: PropertyKey[] }[] }).issues?.[0];
    const at = issue ? graph.capabilities[Number(issue.path[1])]?.id : undefined;
    throw new UsageError(
      issue ? `${at ?? "the graph"}: ${issue.message}` : (error as Error).message,
    );
  }
  await writeFile(p.graphPath, serializeGraph(updated));
  for (const line of changes) io.out(`~ ${line}`);
  return updated;
}

async function review(io: Io, values: Values): Promise<number> {
  const p = project(io, values.dir as string | undefined);
  const graph = await correct(io, p, await loadGraph(p), values);
  let lock = await loadLock(p, graph.tenant);
  const reviewed = await applyLockfile(graph, lock);
  const by = (values.by as string | undefined) ?? io.env.KAPABL_REVIEWER ?? io.env.USER ?? "";
  if (!by) throw new UsageError("say who is reviewing with --by NAME");
  const now = io.now();
  const known = new Set(graph.capabilities.map((c) => c.id));

  const approve = values["approve-all"]
    ? reviewed.capabilities.filter((c) => c.approval === "pending").map((c) => c.id)
    : ids(values.approve);
  const reject = ids(values.reject);
  for (const id of [...approve, ...reject]) {
    if (!known.has(id)) throw new UsageError(`unknown capability "${id}"`);
  }
  const both = approve.filter((id) => reject.includes(id));
  if (both.length > 0) throw new UsageError(`cannot approve and reject "${both[0]}"`);

  const decisions = new Map<string, "approved" | "rejected">();
  for (const id of approve) decisions.set(id, "approved");
  for (const id of reject) decisions.set(id, "rejected");

  if (decisions.size === 0) {
    const pending = reviewed.capabilities.filter((c) => c.approval === "pending");
    if (pending.length === 0) {
      io.out("Nothing to review.");
      return 0;
    }
    if (!io.ask) {
      io.out(`${pending.length} pending:`);
      for (const c of pending) for (const line of describe(c)) io.out(line);
      io.out("Run interactively, or pass --approve / --reject.");
      return 1;
    }
    asking: for (const c of pending) {
      for (const line of describe(c)) io.out(line);
      const extra =
        c.sideEffect === "destructive" ? " (destructive: agents must confirm each call)" : "";
      for (;;) {
        let answer: string;
        try {
          answer = (await io.ask(`Approve ${c.id}?${extra} [a]pprove/[r]eject/[s]kip/[q]uit `))
            .trim()
            .toLowerCase();
        } catch {
          // The input closed (Ctrl-D): keep the answers given so far.
          break asking;
        }
        const choice = ANSWERS[answer];
        if (choice === "quit") break asking;
        if (choice === "approve") decisions.set(c.id, "approved");
        else if (choice === "reject") decisions.set(c.id, "rejected");
        if (choice) break;
        io.out(`Answer a, r, s or q.`);
      }
    }
  }

  for (const c of graph.capabilities) {
    const decision = decisions.get(c.id);
    if (decision) lock = await recordDecision(lock, c, decision, by, now);
  }
  await writeFile(p.lockPath, serializeLockfile(lock));
  for (const [id, decision] of [...decisions].sort())
    io.out(`${decision === "approved" ? "✓" : "✗"} ${id} ${decision}`);
  io.out(`Wrote ${p.lockPath}.`);
  return 0;
}

async function test(io: Io, values: Values): Promise<number> {
  const p = project(io, values.dir as string | undefined);
  const graph = await loadGraph(p);
  const lock = await loadLock(p, graph.tenant);
  const json = await readJson(p.contractsPath);
  if (json === undefined)
    throw new UsageError(`no contracts at ${p.contractsPath}: run "kapabl compile" first`);
  const contracts = ContractsFile.parse(json);
  const approved = await emittableCapabilities(graph, lock);
  const results = await runContracts(approved, contracts, {
    apiOrigin: (values["api-origin"] as string | undefined) ?? contracts.apiOrigin,
    authorization: io.env.KAPABL_CONTRACT_AUTHORIZATION,
    // The same names the edge reads from its Worker secrets (AGENTS.md A2: never the agent's token).
    secrets: Object.fromEntries(
      Object.entries(io.env).filter(([name]) => name.startsWith("TENANT_")),
    ),
    includeWrites: values["include-writes"] === true,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  const mark = { pass: "✓", fail: "✗", skip: "-" } as const;
  for (const r of results) io.out(`${mark[r.outcome]} ${r.id}: ${r.detail}`);
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  io.out(`${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped.`);
  if (count("fail") > 0) return 1;
  // A CI gate that ran nothing must not pass (AGENTS.md H4), even with nothing approved.
  if (count("pass") === 0) {
    io.err(
      results.length === 0
        ? "kapabl: no approved http capabilities to test."
        : "kapabl: no contract ran; add example arguments or a credential.",
    );
    return 1;
  }
  return 0;
}

/** `kapabl example ID JSON`: the arguments the contract test for ID calls it with (H4). */
async function example(io: Io, values: Values, positionals: string[]): Promise<number> {
  const [id, json, ...more] = positionals;
  if (!id || json === undefined || more.length > 0)
    throw new UsageError("example needs ID and the arguments as one JSON object");
  const p = project(io, values.dir as string | undefined);
  const graph = await loadGraph(p);
  const capability = graph.capabilities.find((c) => c.id === id);
  if (!capability) throw new UsageError(`unknown capability "${id}"`);
  if (capability.executor.kind !== "http")
    throw new UsageError(`${id} is not an http capability, so it has no contract test`);
  let args: unknown;
  try {
    args = JSON.parse(json);
  } catch {
    throw new UsageError("the arguments are not valid JSON");
  }
  if (args === null || typeof args !== "object" || Array.isArray(args))
    throw new UsageError("the arguments must be a JSON object");
  const problem = checkExample(capability, args as Record<string, unknown>);
  if (problem) throw new UsageError(`the arguments do not match ${id}'s input schema: ${problem}`);
  const previous = await readJson(p.contractsPath);
  if (previous === undefined)
    throw new UsageError(`no contracts at ${p.contractsPath}: run "kapabl compile" first`);
  const contracts = ContractsFile.parse(previous);
  contracts.examples[id] = args as Record<string, unknown>;
  await writeFile(p.contractsPath, prettyCanonicalJson(contracts));
  io.out(`Wrote the example for ${id} to ${p.contractsPath}.`);
  if (capability.sideEffect === "destructive")
    io.out(
      "Destructive actions never run from contract tests; the example is kept for the record.",
    );
  return 0;
}

/**
 * `kapabl audit`: the free action audit. It compiles in memory, the capture
 * scrubbed first (H1), and writes one HTML page; the project folder is never touched.
 */
async function audit(io: Io, values: Values): Promise<number> {
  const harPath = values.har as string | undefined;
  const openapiPath = values.openapi as string | undefined;
  if (values.site !== undefined) {
    if (harPath || openapiPath) throw new UsageError("--site goes without --har or --openapi");
    return siteAudit(io, values);
  }
  if (Boolean(harPath) === Boolean(openapiPath))
    throw new UsageError("audit needs exactly one of --har, --openapi or --site");
  const source = resolve(io.cwd, (harPath ?? openapiPath) as string);
  const out = resolve(io.cwd, (values.out as string | undefined) ?? "audit.html");
  if (await sameFileAsAny(out, [source])) throw new UsageError("--out would overwrite the source");
  const levelText = values["cloudflare-level"] as string | undefined;
  const cloudflareLevel = levelText === undefined ? undefined : Number(levelText);
  if (
    cloudflareLevel !== undefined &&
    !(Number.isInteger(cloudflareLevel) && cloudflareLevel >= 0 && cloudflareLevel <= 5)
  )
    throw new UsageError("--cloudflare-level is a level from 0 to 5");

  const { result } = await compileSource(io, values);
  const har = "scrub" in result ? result : undefined;
  const html = auditHtml({
    sourceName: basename(source),
    sourceKind: har ? "har" : "openapi",
    apiOrigin: result.apiOrigin,
    capabilities: result.capabilities,
    skipped: result.skipped,
    ...(har
      ? {
          pages: har.pages,
          scrub: {
            entries: har.scrub.entries,
            headersDropped: har.scrub.headersDropped,
            queryParamsDropped: har.scrub.queryParamsDropped,
            redacted: Object.values(har.scrub.redactions).reduce((a, b) => a + (b ?? 0), 0),
          },
        }
      : {}),
    ...(cloudflareLevel !== undefined ? { cloudflareLevel } : {}),
    generatedAt: io.now(),
  });
  await writeFile(out, html);
  const count = (effect: Capability["sideEffect"]) =>
    result.capabilities.filter((c) => c.sideEffect === effect).length;
  io.out(
    `${result.capabilities.length} actions (${count("read")} reads, ${count("write")} writes, ` +
      `${count("destructive")} destructive), ${result.skipped.length} left out.`,
  );
  io.out(`Wrote ${out}.`);
  return 0;
}

/** Cloudflare's public scanner, the one behind isitagentready.com. */
const SCANNER = "https://isitagentready.com/api/scan";

/**
 * `kapabl audit --site`: the website audit, for a site with no API. The level and checks are
 * Cloudflare's; the only thing that leaves this machine is the site's address.
 */
async function siteAudit(io: Io, values: Values): Promise<number> {
  let url: URL;
  try {
    url = new URL(values.site as string);
  } catch {
    throw new UsageError("--site is the site's address, like https://example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new UsageError("--site is the site's address, like https://example.com");
  const category = (values.category as string | undefined) ?? "all";
  if (!Object.hasOwn(RADAR.categories, category))
    throw new UsageError(`--category is one of: ${Object.keys(RADAR.categories).join(", ")}`);
  const out = resolve(io.cwd, (values.out as string | undefined) ?? "audit.html");

  const response = await (io.fetch ?? fetch)(SCANNER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.origin }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Cloudflare's scanner answered ${response.status}.`);
  const scan = (await response.json()) as {
    level?: unknown;
    levelName?: unknown;
    checks?: Record<string, Record<string, { status?: unknown }>>;
  };
  if (typeof scan.level !== "number" || typeof scan.checks !== "object" || scan.checks === null)
    throw new Error("Cloudflare's scanner sent an answer this version does not understand.");
  const checks: Record<string, "pass" | "fail" | "neutral"> = {};
  for (const group of Object.values(scan.checks)) {
    for (const [name, check] of Object.entries(group ?? {})) {
      const status = check?.status;
      if (status === "pass" || status === "fail" || status === "neutral") checks[name] = status;
    }
  }
  await writeFile(
    out,
    siteAuditHtml({
      url: url.origin,
      level: scan.level,
      levelName: typeof scan.levelName === "string" ? scan.levelName : "",
      checks,
      category: category as SiteCategory,
      scannedAt: io.now(),
    }),
  );
  const passed = SITE_CHECKS.filter((check) => checks[check] === "pass").length;
  io.out(`Level ${scan.level} of 5: ${passed} of ${SITE_CHECKS.length} checks pass.`);
  io.out(`Wrote ${out}.`);
  return 0;
}

/**
 * Whether `path` is one of `files`, however it is spelled: by device and inode, so a
 * symlink or another case on a case-insensitive disk is caught too.
 */
async function sameFileAsAny(path: string, files: string[]): Promise<boolean> {
  if (files.includes(path)) return true;
  const id = async (p: string) => {
    try {
      const s = await stat(p);
      return `${s.dev}:${s.ino}`;
    } catch {
      return undefined;
    }
  };
  const target = await id(path);
  if (target === undefined) return false;
  for (const file of files) if ((await id(file)) === target) return true;
  return false;
}

async function emit(io: Io, values: Values): Promise<number> {
  const p = project(io, values.dir as string | undefined);
  const out = values.openapi as string | undefined;
  if (!out) throw new UsageError("emit needs --openapi FILE");
  if (await sameFileAsAny(resolve(io.cwd, out), [p.graphPath, p.lockPath, p.contractsPath]))
    throw new UsageError(`${out} is one of this project's own files`);
  const graph = await loadGraph(p);
  const approved = await emittableCapabilities(graph, await loadLock(p, graph.tenant));
  const json = await readJson(p.contractsPath);
  const apiOrigin =
    (values["api-origin"] as string | undefined) ??
    (json === undefined ? undefined : ContractsFile.parse(json).apiOrigin);
  if (!apiOrigin) throw new UsageError("pass --api-origin");
  const { document, skipped } = openApiDocument(
    {
      title: (values.title as string | undefined) ?? `${graph.tenant} API`,
      version: (values.version as string | undefined) ?? "1.0.0",
      apiOrigin,
    },
    approved,
  );
  await writeFile(resolve(io.cwd, out), prettyCanonicalJson(document));
  io.out(`Wrote ${Object.keys(document.paths as object).length} paths to ${out}.`);
  for (const s of skipped) io.out(`  - ${s.id}: ${s.reason}`);
  return 0;
}

/** The options each command takes; any other is a usage error, never silently ignored. */
const OPTIONS = {
  compile: {
    dir: { type: "string" },
    har: { type: "string" },
    openapi: { type: "string" },
    tenant: { type: "string" },
    "api-origin": { type: "string" },
  },
  review: {
    dir: { type: "string" },
    approve: { type: "string", multiple: true },
    "approve-all": { type: "boolean" },
    reject: { type: "string", multiple: true },
    by: { type: "string" },
    price: { type: "string", multiple: true },
    "side-effect": { type: "string", multiple: true },
  },
  example: {
    dir: { type: "string" },
  },
  audit: {
    har: { type: "string" },
    openapi: { type: "string" },
    out: { type: "string" },
    "api-origin": { type: "string" },
    "cloudflare-level": { type: "string" },
    site: { type: "string" },
    category: { type: "string" },
  },
  test: {
    dir: { type: "string" },
    "api-origin": { type: "string" },
    "include-writes": { type: "boolean" },
  },
  emit: {
    dir: { type: "string" },
    openapi: { type: "string" },
    "api-origin": { type: "string" },
    title: { type: "string" },
    version: { type: "string" },
  },
} as const;

export async function run(argv: readonly string[], raw: Io): Promise<number> {
  // Graphs, captures and origins are untrusted: nothing they say reaches the terminal raw.
  const io: Io = {
    ...raw,
    out: (line) => raw.out(printable(line)),
    err: (line) => raw.err(printable(line)),
  };
  const [command, ...rest] = argv;
  try {
    const options =
      command !== undefined && Object.hasOwn(OPTIONS, command)
        ? OPTIONS[command as keyof typeof OPTIONS]
        : {};
    const { values, positionals } = parseArgs({
      args: rest,
      strict: true,
      options,
      allowPositionals: command === "example",
    }) as { values: Values; positionals: string[] };
    switch (command) {
      case "compile":
        return await compile(io, values);
      case "review":
        return await review(io, values);
      case "test":
        return await test(io, values);
      case "emit":
        return await emit(io, values);
      case "example":
        return await example(io, values, positionals);
      case "audit":
        return await audit(io, values);
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`kapabl: ${message}`);
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      io.err('Run "kapabl help" for usage.');
      return 2;
    }
    return 1;
  }
}
