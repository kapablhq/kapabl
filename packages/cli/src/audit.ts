// SPDX-License-Identifier: Apache-2.0
// The action audit: one self-contained HTML page, made on the prospect's own
// machine from the same compile `kapabl compile` runs, so it can never claim something the
// product does not do. Facts only (AGENTS.md D5): counts and lists the reader can check
// against their own API, no invented scores. Comparisons come from benchmarks.ts, which
// says who measured each figure and when. Everything from the source is escaped.
//
// The website audit (`siteAuditHtml`) is the same kind of page for a site with no API: the
// level and checks are Cloudflare's, from its public scanner, shown in plain words.

import type { Capability } from "@kapabl/graph";
import {
  PUBLIC_APIS,
  publicApiSpread,
  RADAR,
  radarShare,
  SITE_CHECKS,
  type SiteCategory,
  type SiteCheck,
} from "./benchmarks.ts";
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
  /** For a sample published for visitors to look at: a sentence saying what it is of. */
  sample?: string;
  generatedAt: Date;
}

export interface SiteAuditInput {
  url: string;
  /** Cloudflare's level for the site, 0 to 5, and its name for that level. */
  level: number;
  levelName: string;
  /** Cloudflare's result for each check it ran, by its key. */
  checks: Readonly<Record<string, "pass" | "fail" | "neutral">>;
  /** Which of Cloudflare's site categories to compare with. */
  category: SiteCategory;
  sample?: string;
  scannedAt: Date;
}

/** Where Kapabl's own site stands, scanned on isitagentready.com. */
export const KAPABL_LEVEL = { level: 5, name: "Agent-Native", scanned: "2026-11-10" } as const;

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

/** A share as people say it: whole percents, and "under 1%" for what would round to none. */
function share(part: number, whole: number): string {
  const percent = whole === 0 ? 0 : (part / whole) * 100;
  return part > 0 && percent < 1 ? "under 1%" : `${Math.round(percent)}%`;
}

/**
 * One bar split by share. The line under it gives every number in words, so the picture
 * adds nothing a screen reader or a printout without color would miss.
 */
function splitBar(parts: readonly { label: string; n: number; tone: string }[]): string {
  const total = parts.reduce((sum, part) => sum + part.n, 0);
  if (total === 0) return "";
  let x = 0;
  const rects = parts
    .map((part) => {
      const width = (part.n / total) * 100;
      const rect = `<rect class="${part.tone}" x="${x.toFixed(2)}" width="${width.toFixed(2)}" height="10"/>`;
      x += width;
      return rect;
    })
    .join("");
  return `<figure class="split">
<svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">${rects}</svg>
<figcaption>${parts
    .filter((part) => part.n > 0)
    .map(
      (part) =>
        `<span><i class="${part.tone}"></i>${part.n} ${part.label} (${share(part.n, total)})</span>`,
    )
    .join("")}</figcaption>
</figure>`;
}

/** A track filled to a share: how common something is among the sites compared with. */
function meter(part: number, whole: number): string {
  const width = whole === 0 ? 0 : (part / whole) * 100;
  return `<svg class="meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="6"/><rect class="fill" width="${width.toFixed(2)}" height="6"/></svg>`;
}

/**
 * The reader's share beside the public APIs': a band from the lowest to the highest, a
 * tick at the middle one and a mark for theirs. The sentence beside it says the same.
 */
function compared(
  label: string,
  mine: number,
  measure: (api: (typeof PUBLIC_APIS.apis)[number]) => number,
): string {
  const { low, median, high } = publicApiSpread(measure);
  const at = (value: number) => Math.min(100, Math.max(0, value)).toFixed(2);
  return `<li>
<div><strong>${label}</strong>: yours ${Math.round(mine)}%, typical ${Math.round(median)}% (from ${Math.round(low)}% to ${Math.round(high)}%)</div>
<svg class="spread" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" y="3" width="100" height="4"/><rect class="band" x="${at(low)}" y="3" width="${at(high - low)}" height="4"/><rect class="mid" x="${at(median - 0.25)}" y="1" width="0.5" height="8"/><rect class="mine" x="${at(mine - 0.6)}" width="1.2" height="10"/></svg>
</li>`;
}

/** A wide table scrolls sideways in its own box, which the keyboard can reach and scroll. */
function scrolling(name: string, table: string): string {
  return `<div class="scroll" role="region" aria-label="${name}" tabindex="0">\n${table}\n</div>`;
}

function actionTable(
  name: string,
  capabilities: readonly Capability[],
  showConfidence: boolean,
): string {
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
  return scrolling(
    name,
    `<table>
<thead><tr><th>Action</th><th>Request</th><th>Who can call it</th><th>Credential sent to your API</th>${showConfidence ? '<th class="num">Confidence</th>' : ""}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`,
  );
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
${actionTable(title, capabilities, confidence)}
</section>`;
}

const STYLE = `
:root { color-scheme: light; --bg: #FAFAFA; --raised: #FFFFFF; --fg: #0A0A0A; --muted: #52525B; --line: #E0E0E0; --chip: #F0F0F0; --accent: #12A150; --warn: #C53030; --soft: #D4D4D8; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: break-word; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 6px; text-wrap: balance; }
h2 { font-size: 20px; line-height: 1.3; margin: 40px 0 6px; text-wrap: balance; }
h3, h2.small { font-size: 16px; margin: 12px 0 4px; }
a { color: var(--fg); text-decoration-color: var(--accent); text-decoration-thickness: 1.5px; text-underline-offset: 0.25em; }
.sample { margin: 0 0 24px; padding: 10px 14px; border: 1.5px solid var(--line); border-radius: 10px; background: var(--raised); }
.lede { font-size: 19px; line-height: 1.5; margin: 20px 0; max-width: 46em; }
.count { display: inline-block; min-width: 24px; padding: 0 8px; border-radius: 12px; background: var(--chip); color: var(--muted); font-size: 13px; font-weight: 500; text-align: center; vertical-align: middle; }
.meta, .note, .sub { color: var(--muted); }
.meta, .note { font-size: 14px; }
.callout { border-left: 3px solid var(--warn); padding: 8px 12px; background: var(--raised); }
.sub { font-size: 13px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 24px 0; }
.stat, .card { border: 1.5px solid var(--line); border-radius: 12px; background: var(--raised); padding: 12px 14px; }
.stat .n { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat .label { color: var(--muted); font-size: 13px; }
.card { padding: 16px 18px; margin: 16px 0; }
.card > :first-child { margin-top: 0; }
.card > :last-child { margin-bottom: 0; }
figure { margin: 12px 0; }
svg { display: block; width: 100%; }
.split svg { height: 22px; border-radius: 6px; }
.split figcaption { display: flex; flex-wrap: wrap; gap: 4px 20px; margin-top: 8px; font-size: 14px; }
.split i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.soft { background: var(--soft); fill: var(--soft); }
.ink { background: var(--muted); fill: var(--muted); }
.risk { background: var(--warn); fill: var(--warn); }
.yes { background: var(--accent); fill: var(--accent); }
.track { fill: var(--chip); }
.fill { fill: var(--muted); }
.band { background: var(--soft); fill: var(--soft); }
.mid { background: var(--muted); fill: var(--muted); }
.mine { background: var(--fg); fill: var(--fg); }
.vs { list-style: none; padding: 0; margin: 12px 0 0; }
.vs li { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 6px 24px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); font-size: 15px; }
.spread { height: 16px; }
.key { display: flex; flex-wrap: wrap; gap: 4px 20px; font-size: 13px; color: var(--muted); }
.key i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; }
.levels { list-style: none; display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; padding: 0; margin: 12px 0 6px; max-width: 420px; }
.levels li { padding: 8px 0; border-radius: 8px; background: var(--chip); color: var(--muted); text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.levels .at { background: var(--fg); color: var(--bg); }
.checks { list-style: none; padding: 0; margin: 8px 0 0; }
.checks li { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 4px 12px; padding: 12px 0; border-top: 1px solid var(--line); }
.mark { font-weight: 600; font-size: 14px; white-space: nowrap; }
.mark svg { display: inline-block; width: 18px; height: 18px; vertical-align: -4px; margin-right: 4px; }
.mark .ring { fill: none; stroke: var(--muted); stroke-width: 2; }
.mark .tick { fill: none; stroke: #fff; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.peer { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; margin-top: 8px; color: var(--muted); font-size: 13px; }
.meter { flex: none; width: 140px; height: 6px; border-radius: 3px; }
.compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.compare > div { border: 1.5px solid var(--line); border-radius: 12px; background: var(--raised); padding: 4px 16px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; white-space: nowrap; }
.num { text-align: right; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
ul { padding-left: 20px; }
@media print { main { padding: 0; } section, .card { break-inside: avoid; } svg { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
`;

function page(title: string, sample: string | undefined, body: string): string {
  const notice = sample
    ? `<p class="sample"><strong>Sample report.</strong> ${html(sample)} <a href="https://kapabl.dev/audit">Get one for your own site, free</a>.</p>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
${sample ? "" : '<meta name="robots" content="noindex">\n'}<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${notice}${body}
</main>
</body>
</html>
`;
}

export function auditHtml(input: AuditInput): string {
  const by = (effect: Capability["sideEffect"]) =>
    input.capabilities.filter((c) => c.sideEffect === effect);
  const reads = by("read");
  const writes = by("write");
  const destructive = by("destructive");
  const total = input.capabilities.length;
  const signedIn = input.capabilities.filter((c) => c.auth.kind === "oauth").length;
  const priced = input.capabilities.filter((c) => c.price).length;
  const keyed = input.capabilities.filter((c) => c.sideEffect !== "read" && onSiteKey(c)).length;
  const onKey = input.capabilities.filter(onSiteKey).length;
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
${scrolling(
  "Left out",
  `<table>
<thead><tr><th>Request</th><th>Reason</th></tr></thead>
<tbody>
${input.skipped
  .map(
    (s) =>
      `<tr><td><code>${html(`${s.method} ${s.path}`)}</code></td><td>${html(s.reason)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`,
)}
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

  const lede =
    total === 0
      ? `<p class="lede">No action an AI assistant could use was found in this ${har ? "capture" : "document"}.</p>`
      : `<p class="lede">An AI assistant could do <strong>${total}</strong> ${total === 1 ? "thing" : "things"} in this product. ${reads.length} only look something up, ${writes.length} change something, and ${destructive.length} ${destructive.length === 1 ? "is" : "are"} risky: they delete, cancel, refund or pay.</p>`;

  // The public APIs left out of the comparison had fewer than ten actions; so does this.
  const percent = (n: number) => (n / total) * 100;
  const comparison =
    total < 10
      ? ""
      : `<h2 class="small">Compared with ${PUBLIC_APIS.apis.length} public APIs</h2>
<ul class="vs">
${compared("Look something up", percent(reads.length), (api) => (api[2] / api[1]) * 100)}
${compared("Change something", percent(writes.length), (api) => (api[3] / api[1]) * 100)}
${compared("Risky", percent(destructive.length), (api) => (api[4] / api[1]) * 100)}
</ul>
<p class="key"><span><i class="mine"></i>yours</span><span><i class="mid"></i>typical (the middle one)</span><span><i class="band"></i>lowest to highest</span></p>
<p class="note">The same audit, run on the public API descriptions of ${PUBLIC_APIS.apis
          .map((api) => api[0])
          .join(", ")} on ${PUBLIC_APIS.date}.</p>`;

  return page(
    "Action audit",
    input.sample,
    `<h1>Action audit</h1>
<p class="meta">API <code>${html(input.apiOrigin)}</code> · from ${har ? "the capture" : "the OpenAPI document"} <code>${html(input.sourceName)}</code> · ${date}</p>
${scrub}
${lede}

<div class="stats">
${stat(total, "actions found")}
${stat(reads.length, "reads")}
${stat(writes.length, "writes")}
${stat(destructive.length, "destructive")}
${stat(signedIn, "need a signed-in user")}
${stat(input.skipped.length, "left out")}
${priced > 0 ? stat(priced, "priced per call") : ""}
</div>

${
  total === 0
    ? ""
    : `<div class="card">
<h2 class="small">What the actions do</h2>
${splitBar([
  { label: "look something up", n: reads.length, tone: "soft" },
  { label: "change something", n: writes.length, tone: "ink" },
  { label: "risky", n: destructive.length, tone: "risk" },
])}
<h2 class="small">Who could call them</h2>
${splitBar([
  { label: "need a signed-in user", n: signedIn, tone: "yes" },
  { label: "any agent, with your API key", n: onKey, tone: "ink" },
  { label: "anyone", n: total - signedIn - onKey, tone: "soft" },
])}
${comparison}
</div>`
}

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
<p>Through Kapabl, the ${total} actions above become MCP tools once you approve each one. Nothing is live before that.</p>
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

<p class="note">Made with <code>kapabl audit</code>. Classes are inferred${
      har ? " from the capture" : " from methods and operation names"
    } and are yours to correct in review.</p>`,
  );
}

/** What each check is, for someone who has never heard its name. */
const CHECK_TEXT: Record<SiteCheck, readonly [name: string, what: string]> = {
  robotsTxt: ["A robots.txt file", "Tells crawlers and AI bots which pages they may visit."],
  sitemap: ["A sitemap", "A list of your pages, so none is missed."],
  linkHeaders: [
    "Pointers for machines",
    "Each page says where its machine-readable version and your other files for assistants are.",
  ],
  markdownNegotiation: [
    "A plain-text version of each page",
    "The same page without the layout (Markdown), served when an assistant asks for it.",
  ],
  robotsTxtAiRules: ["Rules for AI bots", "Says which AI crawlers may visit your site."],
  contentSignals: [
    "Your terms for AI use",
    "Says whether AI may train on your content, show it in search, or use it in answers.",
  ],
  mcpServerCard: [
    "A place assistants can call (MCP)",
    "Lets an assistant do something on your site for a visitor, such as send you a message.",
  ],
  ard: ["An AI catalog", "One file that lists what your site offers to assistants."],
  apiCatalog: ["A list of your APIs", "Where an assistant finds the description of each one."],
  agentSkills: ["Published skills", "Short guides that tell an assistant how to use your site."],
  oauthProtectedResource: [
    "Sign-in details for assistants",
    "Tells an assistant how a visitor signs in before it acts for them.",
  ],
};

/** The checks grouped by the question a site owner would ask. */
const QUESTIONS: readonly (readonly [
  question: string,
  short: string,
  note: string,
  checks: readonly SiteCheck[],
])[] = [
  [
    "Can AI assistants find your pages?",
    "find your pages",
    "",
    ["robotsTxt", "sitemap", "linkHeaders"],
  ],
  ["Can they read your pages?", "read your pages", "", ["markdownNegotiation"]],
  [
    "Have you said what AI may do with your content?",
    "your rules for AI",
    "",
    ["robotsTxtAiRules", "contentSignals"],
  ],
  [
    "Can they do something for a visitor?",
    "act for a visitor",
    "This only matters if you want an assistant to act on your site: send you a message, book a call, place an order.",
    ["mcpServerCard", "ard", "apiCatalog", "agentSkills", "oauthProtectedResource"],
  ],
];

const MARKS = {
  pass: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="yes" cx="12" cy="12" r="12"/><path class="tick" d="M7 12.5l3.2 3.2L17 9"/></svg>Yes',
  fail: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="ring" cx="12" cy="12" r="10"/></svg>Not yet',
  neutral:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="ring" d="M6 12h12"/></svg>Not checked',
};

export function siteAuditHtml(input: SiteAuditInput): string {
  const status = (check: SiteCheck) => input.checks[check] ?? "neutral";
  const [categoryName] = RADAR.categories[input.category];
  const peers =
    input.category === "all"
      ? "the most visited sites of every kind"
      : `the most visited sites in Cloudflare's "${categoryName}" category`;
  const passes = (checks: readonly SiteCheck[]) =>
    checks.filter((check) => status(check) === "pass").length;
  const passed = passes(SITE_CHECKS);
  const level = Math.min(5, Math.max(0, Math.trunc(input.level)));
  const date = input.scannedAt.toISOString().slice(0, 10);
  const sites = radarShare(input.category, "robotsTxt").sites;

  const row = (check: SiteCheck) => {
    const [name, what] = CHECK_TEXT[check];
    const { pass } = radarShare(input.category, check);
    return `<li>
<div class="mark">${MARKS[status(check)]}</div>
<div><strong>${name}</strong><div class="sub">${what}</div>
<div class="peer">${meter(pass, sites)}<span>${share(pass, sites)} of similar sites have this</span></div></div>
</li>`;
  };

  return page(
    "Website audit",
    input.sample,
    `<h1>How AI assistants see your website</h1>
<p class="meta"><code>${html(input.url)}</code> · scanned ${date}</p>
<p class="lede">Your site passes <strong>${passed} of ${SITE_CHECKS.length}</strong> checks for working with AI assistants such as ChatGPT and Claude. Cloudflare's scanner puts it at <strong>Level ${level} of 5</strong> (${html(input.levelName)}).</p>

<div class="card">
<h2 class="small">Your level</h2>
<ol class="levels" start="0" aria-label="Level ${level} of 5">${[0, 1, 2, 3, 4, 5]
      .map((step) => `<li${step === level ? ' class="at" aria-current="true"' : ""}>${step}</li>`)
      .join("")}</ol>
<p class="note">0 is a site assistants can barely use; 5 is one built for them. The level is Cloudflare's, from its free scanner at <code>isitagentready.com</code>.</p>
</div>

<div class="stats">
${QUESTIONS.map(
  ([, short, , checks]) =>
    `<div class="stat"><div class="n">${passes(checks)} of ${checks.length}</div><div class="label">${short}</div></div>`,
).join("\n")}
</div>
<p class="note">Under each check: how many similar sites have it. Similar sites here are ${sites.toLocaleString("en-US")} of ${html(peers)}, as Cloudflare measured them.</p>

${QUESTIONS.map(
  ([question, , note, checks]) => `<section>
<h2>${question} <span class="count">${passes(checks)} of ${checks.length}</span></h2>
${note ? `<p>${note}</p>\n` : ""}<ul class="checks">
${checks.map(row).join("\n")}
</ul>
</section>`,
).join("\n")}

<section>
<h2>A site served through Kapabl</h2>
<p>kapabl.dev is served through Kapabl. On the same scanner it reached <strong>Level ${KAPABL_LEVEL.level} (${KAPABL_LEVEL.name})</strong> on ${KAPABL_LEVEL.scanned} and passed every check on this page.</p>
</section>

<p class="note">Where the numbers come from. Your level and checks: Cloudflare's scanner, which was sent only your site's address. Sites like yours: ${RADAR.source}, ${html(categoryName)} (${sites.toLocaleString("en-US")} of the 200,000 most visited sites), data of ${RADAR.date}. Made with <code>kapabl audit</code>.</p>`,
  );
}
