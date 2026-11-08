// SPDX-License-Identifier: Apache-2.0
// The action audit: one self-contained HTML page, made on the prospect's own
// machine from the same compile `kapabl compile` runs, so it can never claim something the
// product does not do. Facts only (AGENTS.md D5): counts and lists the reader can check
// against their own API, no invented scores. Everything from the source is escaped.

import type { Capability } from "@kapabl/graph";
import { credentialText, printable } from "./text.ts";

export interface AuditInput {
  /** The source file's name only: a full path can carry a user name. */
  sourceName: string;
  sourceKind: "openapi" | "har";
  apiOrigin: string;
  capabilities: readonly Capability[];
  skipped: readonly { method: string; path: string; reason: string }[];
  /** HAR only: pages a person opened (origin + path template). */
  pages?: readonly string[];
  /** HAR only: how much the scrub removed before anything was read. */
  scrub?: { entries: number; headersDropped: number; queryParamsDropped: number; redacted: number };
  /** The level the reader's site scored on isitagentready.com, if they gave it. */
  cloudflareLevel?: number;
  generatedAt: Date;
}

/** Where Kapabl's own site stands, scanned on isitagentready.com. */
export const KAPABL_LEVEL = { level: 4, name: "Agent-Integrated", scanned: "2026-11-01" } as const;

function html(text: string): string {
  return printable(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function request(c: Capability): string {
  return c.executor.kind === "http" ? `${c.executor.method} ${c.executor.path}` : c.executor.kind;
}

/** An action any agent may call that still reaches the API with the site's own secret. */
function onSiteKey(c: Capability): boolean {
  return (
    c.auth.kind === "none" &&
    c.executor.kind === "http" &&
    c.executor.credential.kind === "tenant-secret"
  );
}

/** A write whose path ends like a lookup: often a search sent as POST. */
function looksLikeSearch(c: Capability): boolean {
  if (c.executor.kind !== "http" || c.executor.method !== "POST") return false;
  const last = c.executor.path.split("/").filter(Boolean).at(-1) ?? "";
  return /^(?:search|list|query|find|lookup|filter)$/i.test(last);
}

function who(c: Capability): string {
  if (c.auth.kind === "oauth")
    return `Signed-in user${c.auth.scopes.length > 0 ? ` (${c.auth.scopes.join(", ")})` : ""}`;
  return onSiteKey(c) ? "Any agent, with your API key" : "Anyone";
}

function actionTable(capabilities: readonly Capability[], showConfidence: boolean): string {
  const rows = capabilities
    .map(
      (c) => `<tr>
<td><code>${html(c.id)}</code><div class="sub">${html(c.title)}</div></td>
<td><code>${html(request(c))}</code></td>
<td>${html(who(c))}</td>
<td>${html(credentialText(c))}</td>${showConfidence ? `\n<td class="num">${c.confidence.toFixed(1)}</td>` : ""}
</tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr><th>Action</th><th>Request</th><th>Who can call it</th><th>Credential sent to your API</th>${showConfidence ? '<th class="num">Confidence</th>' : ""}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function section(
  title: string,
  intro: string,
  capabilities: readonly Capability[],
  confidence: boolean,
): string {
  if (capabilities.length === 0) return "";
  return `<section>
<h2>${title} <span class="count">${capabilities.length}</span></h2>
<p>${intro}</p>
${actionTable(capabilities, confidence)}
</section>`;
}

export function auditHtml(input: AuditInput): string {
  const by = (effect: Capability["sideEffect"]) =>
    input.capabilities.filter((c) => c.sideEffect === effect);
  const reads = by("read");
  const writes = by("write");
  const destructive = by("destructive");
  const signedIn = input.capabilities.filter((c) => c.auth.kind === "oauth").length;
  const priced = input.capabilities.filter((c) => c.price).length;
  const keyed = input.capabilities.filter((c) => c.sideEffect !== "read" && onSiteKey(c)).length;
  const searches = writes.filter(looksLikeSearch).length;
  const har = input.sourceKind === "har";
  const date = input.generatedAt.toISOString().slice(0, 10);
  const level = input.cloudflareLevel;

  const stat = (n: number, label: string) =>
    `<div class="stat"><div class="n">${n}</div><div class="label">${label}</div></div>`;

  const skipped =
    input.skipped.length === 0
      ? ""
      : `<section>
<h2>Left out <span class="count">${input.skipped.length}</span></h2>
<p>Requests that did not become actions, and why.</p>
<table>
<thead><tr><th>Request</th><th>Reason</th></tr></thead>
<tbody>
${input.skipped
  .map(
    (s) =>
      `<tr><td><code>${html(`${s.method} ${s.path}`)}</code></td><td>${html(s.reason)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>
</section>`;

  const pages =
    har && input.pages && input.pages.length > 0
      ? `<section>
<h2>Pages opened in the capture <span class="count">${input.pages.length}</span></h2>
<p>Screens a person used while recording. Anything done only on these pages, with no JSON
call to your API in the capture, cannot become a tool from this capture. Flows like these
are the browser executor's work, which is not available yet.</p>
<ul>
${input.pages.map((page) => `<li><code>${html(page)}</code></li>`).join("\n")}
</ul>
</section>`
      : "";

  const scrub =
    har && input.scrub
      ? `<p class="note">The capture was scrubbed before it was read: ${input.scrub.entries} requests,
${input.scrub.headersDropped} credential headers and ${input.scrub.queryParamsDropped} sensitive
parameters dropped, ${input.scrub.redacted} values redacted. Nothing was uploaded.</p>`
      : `<p class="note">Made on this machine. Nothing was uploaded.</p>`;

  const today =
    level === undefined
      ? `<p>Your level today: scan your site at <code>isitagentready.com</code>.</p>`
      : `<p>Your level today on isitagentready.com: <strong>Level ${level}</strong>, as you entered it.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Action audit</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #5f6368; --line: #e3e3e3; --accent: #3b5bdb; --chip: #f1f3f5; --warn: #b4234b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181c; --fg: #e8e8e8; --muted: #a0a4ab; --line: #30333a; --accent: #8ea6ff; --chip: #22252b; --warn: #ff8fab; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 36px 0 6px; }
.count { display: inline-block; min-width: 24px; padding: 0 8px; border-radius: 12px; background: var(--chip); color: var(--muted); font-size: 13px; text-align: center; }
.meta, .note, .sub { color: var(--muted); }
.callout { border-left: 3px solid var(--warn); padding: 8px 12px; background: var(--chip); }
.sub { font-size: 13px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 24px 0; }
.stat { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.stat .n { font-size: 26px; font-weight: 600; }
.stat .label { color: var(--muted); font-size: 13px; }
.compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.compare > div { border: 1px solid var(--line); border-radius: 8px; padding: 4px 16px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; display: block; overflow-x: auto; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; white-space: nowrap; }
.num { text-align: right; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
ul { padding-left: 20px; }
@media print { main { padding: 0; } section { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>Action audit</h1>
<p class="meta">API <code>${html(input.apiOrigin)}</code> · from ${har ? "the capture" : "the OpenAPI document"} <code>${html(input.sourceName)}</code> · ${date}</p>
${scrub}

<div class="stats">
${stat(input.capabilities.length, "actions found")}
${stat(reads.length, "reads")}
${stat(writes.length, "writes")}
${stat(destructive.length, "destructive")}
${stat(signedIn, "need a signed-in user")}
${stat(input.skipped.length, "left out")}
${priced > 0 ? stat(priced, "priced per call") : ""}
</div>

${
  keyed > 0
    ? `<p class="callout">${keyed} of the writes would run with your API key for any agent, with no signed-in user: the source describes their security as a shared key, not user sign-in. Each one is shown to you in review before anything is live.</p>`
    : ""
}
<section>
<h2>Before and after</h2>
<div class="compare">
<div>
<h3>Discovery (what Cloudflare's free scan measures)</h3>
${today}
<p>kapabl.dev, served through Kapabl: <strong>Level ${KAPABL_LEVEL.level} (${KAPABL_LEVEL.name})</strong>, scanned ${KAPABL_LEVEL.scanned}.</p>
</div>
<div>
<h3>Actions (what agents can do)</h3>
<p>Through Kapabl, the ${input.capabilities.length} actions above become MCP tools once you approve each one. Nothing is live before that.</p>
<p>Agents never send their own token to your API: each call uses the credential listed for it.</p>
</div>
</div>
</section>

${section(
  "Reads",
  "Agents reach these through two tools, <code>search</code> and <code>execute</code>. They change nothing.",
  reads,
  har,
)}
${section(
  "Writes",
  `Each becomes its own tool, marked <code>destructiveHint</code>, so the agent's app can ask the user before calling it.${
    searches > 0
      ? ` ${searches} of them end in <code>/search</code>, <code>/list</code> or similar: searches sent as POST count as writes until review marks them reads.`
      : ""
  }`,
  writes,
  har,
)}
${section(
  "Destructive actions",
  "Deletes, cancels, refunds and payments. Each becomes its own tool, always needs a signed-in user, and Kapabl asks the user to confirm every call. A confirmation works once.",
  destructive,
  har,
)}
${skipped}
${pages}

<p class="note">Made with <code>npx @kapabl/cli audit</code>. Classes are inferred${
    har ? " from the capture" : " from methods and operation names"
  } and are yours to correct in review.</p>
</main>
</body>
</html>
`;
}
