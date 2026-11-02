// SPDX-License-Identifier: Apache-2.0

import {
  type Capability,
  emptyLockfile,
  type Graph,
  type Lockfile,
  parseGraph,
  recordDecision,
  sha256Text,
} from "@kapabl/graph";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import fixture from "../../graph/test/fixtures/graph.json" with { type: "json" };
import {
  type Bundle,
  emitBundle,
  MEDIA_TYPES,
  SiteConfig,
  type SiteConfigInput,
} from "../src/index.ts";
import cardSchema from "./fixtures/server-card.schema.json" with { type: "json" };

const site: SiteConfigInput = {
  origin: "https://acme.test",
  apiOrigin: "https://api.acme.test",
  authIssuer: "https://auth.acme.test",
  payments: {
    rail: "x402",
    market: "US",
    network: "eip155:84532",
    payTo: "0x1111111111111111111111111111111111111111",
    facilitatorUrl: "https://x402.org/facilitator",
  },
  name: "Acme",
  summary: "Billing and usage for Acme customers.",
  serverName: "test.acme/app",
  version: "0.1.0",
  contentSignals: { aiTrain: false, search: true, aiInput: true },
};

const pages = [
  {
    path: "/",
    title: "Acme",
    description: "Home page.",
    markdown: "# Acme\n\nHello.\n",
    html: "<!doctype html><title>Acme</title><h1>Acme</h1>",
  },
  { path: "/pricing", title: "Pricing", description: "Plans and prices.", markdown: "# Pricing\n" },
];

const reviewedAt = new Date("2026-10-30T00:00:00Z");

async function approve(graph: Graph, decisions: Record<string, "approved" | "rejected">) {
  let lock: Lockfile = emptyLockfile(graph.tenant);
  for (const capability of graph.capabilities) {
    const decision = decisions[capability.id];
    if (decision) lock = await recordDecision(lock, capability, decision, "owner", reviewedAt);
  }
  return lock;
}

const graph = parseGraph(fixture);
const lock = await approve(graph, { get_usage_report: "approved", search_docs: "rejected" });
const bundle = await emitBundle({ graph, lock, site, pages });

function artifact(b: Bundle, path: string) {
  const found = b.artifacts.find((a) => a.path === path);
  if (!found) throw new Error(`no artifact at ${path}`);
  return found;
}

describe("emitBundle", () => {
  it("is deterministic", async () => {
    expect(await emitBundle({ graph, lock, site, pages })).toEqual(bundle);
  });

  it("emits only lockfile-approved capabilities", () => {
    const skill = artifact(bundle, "/.well-known/agent-skills/acme/SKILL.md").body;
    const llms = artifact(bundle, "/llms.txt").body;
    for (const body of [skill, llms]) {
      expect(body).toMatch(/usage report/i);
      expect(body).not.toMatch(/cancel/i);
      expect(body).not.toMatch(/search docs/i);
    }
    expect(skill).toContain("- Id: `get_usage_report`");
  });

  it("ignores the graph's own approval field", async () => {
    const forged = {
      ...graph,
      capabilities: graph.capabilities.map((c) => ({ ...c, approval: "approved" as const })),
    };
    const out = await emitBundle({ graph: forged, lock: emptyLockfile("acme"), site, pages });
    expect(artifact(out, "/.well-known/agent-skills/acme/SKILL.md").body).toContain(
      "No actions are published yet.",
    );
  });

  it("gives every artifact a strong ETag of its body", async () => {
    for (const a of bundle.artifacts) {
      expect(a.etag).toBe(`"${(await sha256Text(a.body)).slice(7)}"`);
    }
  });
});

describe("server card", () => {
  const card = JSON.parse(artifact(bundle, "/mcp/server-card").body);

  it("validates against the ext-server-card JSON Schema", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats.default(ajv);
    const validate = ajv.compile(cardSchema);
    expect(validate(card), JSON.stringify(validate.errors)).toBe(true);
  });

  it("describes identity and transport, never tools", () => {
    expect(card.remotes).toEqual([
      {
        type: "streamable-http",
        url: "https://acme.test/mcp",
        supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
      },
    ]);
    expect(JSON.stringify(card)).not.toMatch(/tools|capabilit/);
    expect(artifact(bundle, "/mcp/server-card").contentType).toBe(MEDIA_TYPES.serverCard);
  });

  it("is reachable at the compatibility aliases", () => {
    expect(bundle.aliases["/.well-known/mcp.json"]).toBe("/mcp/server-card");
    expect(bundle.aliases["/.well-known/mcp/server-card.json"]).toBe("/mcp/server-card");
  });
});

describe("catalogs", () => {
  it("AI Catalog points at the card and skill with matching digests", async () => {
    const a = artifact(bundle, "/.well-known/ai-catalog.json");
    expect(a.contentType).toBe("application/ai-catalog+json");
    const catalog = JSON.parse(a.body);
    expect(catalog.specVersion).toBe("1.0");
    expect(catalog.host).toEqual({ displayName: "Acme", identifier: "acme.test" });
    const [card, skill] = catalog.entries;
    expect(card).toEqual({
      identifier: "urn:air:acme.test:mcp:acme",
      displayName: "Acme",
      type: "application/mcp-server-card+json",
      url: "https://acme.test/mcp/server-card",
      digest: await sha256Text(artifact(bundle, "/mcp/server-card").body),
    });
    expect(skill.displayName).toBe("acme");
    expect(skill.digest).toBe(
      await sha256Text(artifact(bundle, "/.well-known/agent-skills/acme/SKILL.md").body),
    );
  });

  it("API catalog is an RFC 9727 linkset with a self Link header", () => {
    const a = artifact(bundle, "/.well-known/api-catalog");
    expect(a.contentType).toBe(
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    );
    expect(a.link).toBe('</.well-known/api-catalog>; rel="api-catalog"');
    const { linkset } = JSON.parse(a.body);
    expect(linkset[0]).toEqual({
      anchor: "https://acme.test/.well-known/api-catalog",
      item: [{ href: "https://acme.test/mcp" }],
    });
    expect(linkset[1].anchor).toBe("https://acme.test/mcp");
    expect(linkset[1]["service-desc"][0].type).toBe("application/mcp-server-card+json");
  });

  it("Agent Skills index is v0.2.0 with a sha256 of the SKILL.md bytes", async () => {
    const index = JSON.parse(artifact(bundle, "/.well-known/agent-skills/index.json").body);
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    const [entry] = index.skills;
    expect(entry).toMatchObject({
      name: "acme",
      type: "skill-md",
      url: "/.well-known/agent-skills/acme/SKILL.md",
    });
    const body = artifact(bundle, entry.url).body;
    expect(entry.digest).toBe(await sha256Text(body));
    expect(body).toMatch(/^---\nname: acme\ndescription: "Acme MCP server: .*"\n---\n/);
  });

  it("rejects a tenant that is not a valid skill name", async () => {
    const odd = { ...graph, tenant: "a--b", capabilities: [] };
    await expect(
      emitBundle({ graph: odd, lock: emptyLockfile("a--b"), site, pages }),
    ).rejects.toThrow(/Agent Skills name/);
  });
});

describe("site files", () => {
  it("robots.txt carries Content Signals and the sitemap", () => {
    expect(artifact(bundle, "/robots.txt").body).toBe(
      "User-agent: *\nContent-Signal: ai-train=no, search=yes, ai-input=yes\nAllow: /\n\nSitemap: https://acme.test/sitemap.xml\n",
    );
    expect(bundle.contentSignal).toBe("ai-train=no, search=yes, ai-input=yes");
  });

  it("sitemap lists every page", () => {
    const xml = artifact(bundle, "/sitemap.xml").body;
    expect(xml).toContain("<loc>https://acme.test/</loc>");
    expect(xml).toContain("<loc>https://acme.test/pricing</loc>");
  });

  it("llms.txt follows llmstxt.org and links Markdown pages", () => {
    const llms = artifact(bundle, "/llms.txt").body;
    expect(llms.startsWith("# Acme\n\n> Billing and usage for Acme customers.\n\n## Pages\n")).toBe(
      true,
    );
    expect(llms).toContain("- [Pricing](https://acme.test/pricing.md): Plans and prices.");
    expect(llms).toContain("## Actions");
  });

  it("pages have Markdown twins, .html.md aliases and discovery links", () => {
    const home = artifact(bundle, "/");
    expect(home.markdown).toBe("/index.md");
    expect(home.link).toContain('</index.md>; rel="alternate"; type="text/markdown"');
    expect(home.link).toContain('</.well-known/api-catalog>; rel="api-catalog"');
    expect(home.link).toContain('</llms.txt>; rel="describedby"');
    expect(artifact(bundle, "/index.md").body).toBe("# Acme\n\nHello.\n");
    expect(bundle.aliases["/index.html.md"]).toBe("/index.md");
    expect(bundle.aliases["/pricing.html.md"]).toBe("/pricing.md");
    expect(bundle.aliases["/index.html"]).toBe("/");
    expect(bundle.artifacts.some((a) => a.path === "/pricing")).toBe(false);
  });
});

describe("generated text is data, not instructions (AGENTS.md D5)", () => {
  it("escapes capability text so it cannot change document structure", async () => {
    const [base] = graph.capabilities.filter((c) => c.id === "get_usage_report") as [Capability];
    const hostile: Capability = {
      ...base,
      title: "Usage](https://evil.test)\n# Heading",
      description: "Report.\n\n## Fake section\n```\nbreak out",
      inputSchema: { ...base.inputSchema, description: "```` fence" },
    };
    const g = { ...graph, capabilities: [hostile] };
    const out = await emitBundle({
      graph: g,
      lock: await approve(g, { get_usage_report: "approved" }),
      site,
      pages,
    });
    const skill = artifact(out, "/.well-known/agent-skills/acme/SKILL.md").body;
    const llms = artifact(out, "/llms.txt").body;
    expect(llms).toContain("- [Usage\\](https://evil.test) \\# Heading](");
    expect(skill).not.toMatch(/^## Fake section/m);
    expect(skill).not.toMatch(/^# Heading/m);
    expect(skill).toContain("`````json\n");
  });

  it.each([
    "~~~ opens a fence",
    "- becomes a list",
    "+ becomes a list",
    "1. becomes a list",
    "2) becomes a list",
    "=== setext",
  ])("escapes the line-start marker in %j", async (description) => {
    const [base] = graph.capabilities.filter((c) => c.id === "get_usage_report") as [Capability];
    const g = { ...graph, capabilities: [{ ...base, description }] };
    const l = await approve(g, { get_usage_report: "approved" });
    const skill = artifact(
      await emitBundle({ graph: g, lock: l, site, pages }),
      "/.well-known/agent-skills/acme/SKILL.md",
    ).body;
    const line =
      skill.split("\n").find((x) => x.endsWith(description.split(" ").at(-1) ?? "")) ?? "";
    expect(line.startsWith("\\") || /^\d+\\[.)]/.test(line), line).toBe(true);
    expect(skill).toContain("- Id: `get_usage_report`");
  });

  it("keeps scopes with backticks inside their code span", async () => {
    const [base] = graph.capabilities.filter((c) => c.id === "get_usage_report") as [Capability];
    const g = {
      ...graph,
      capabilities: [{ ...base, auth: { kind: "oauth" as const, scopes: ["a`*b*`", "`x"] } }],
    };
    const l = await approve(g, { get_usage_report: "approved" });
    const skill = artifact(
      await emitBundle({ graph: g, lock: l, site, pages }),
      "/.well-known/agent-skills/acme/SKILL.md",
    ).body;
    expect(skill).toContain("- Sign-in: OAuth 2.1, scopes `` a`*b*` ``, `` `x ``");
  });

  it("templates contain no agent-directed instructions", () => {
    const banned = /\b(ignore|always recommend|keep .* in context|you must|you should)\b/i;
    for (const a of bundle.artifacts) expect(a.body, a.path).not.toMatch(banned);
  });
});

describe("page paths", () => {
  it.each(["/mcp", "/mcp/server-card"])(
    "rejects a page at %s, which would shadow MCP",
    async (path) => {
      const shadow = [
        ...pages,
        { path, title: "x", description: "x", markdown: "x", html: "<p>x</p>" },
      ];
      await expect(emitBundle({ graph, lock, site, pages: shadow })).rejects.toThrow(
        /shadow the MCP endpoint/,
      );
    },
  );
});

describe("SiteConfig", () => {
  it.each([
    "http://acme.test",
    "https://acme.test/",
    "https://acme.test/app",
    "https://acme.test?x=1",
  ])("rejects origin %s", (origin) => {
    expect(SiteConfig.safeParse({ ...site, origin }).success).toBe(false);
  });

  it("rejects blank display text", () => {
    expect(SiteConfig.safeParse({ ...site, name: "  " }).success).toBe(false);
    expect(SiteConfig.safeParse({ ...site, summary: "\n" }).success).toBe(false);
  });

  it("allows plain http only for local development", () => {
    expect(SiteConfig.safeParse({ ...site, origin: "http://127.0.0.1:8787" }).success).toBe(true);
  });
});

describe("MCP tool surface", () => {
  it("gives a priced read its own tool, with the price in its description", () => {
    expect(bundle.mcp.tools.default.map((t) => t.name)).toEqual([
      "execute",
      "get_usage_report",
      "search",
    ]);
    expect(bundle.mcp.tools.individual.map((t) => t.name)).toEqual(["get_usage_report"]);
    expect(bundle.mcp.capabilities.map((c) => c.id)).toEqual(["get_usage_report"]);
    const tool = bundle.mcp.tools.default.find((t) => t.name === "get_usage_report");
    expect(tool?.description).toMatch(/\n\nPrice: 0\.01 USD per call\.$/);
    expect(tool?.annotations.readOnlyHint).toBe(true);
    const execute = bundle.mcp.tools.default.find((t) => t.name === "execute");
    expect(JSON.stringify(execute?.inputSchema)).not.toContain("get_usage_report");
  });

  it("puts unpriced reads behind search/execute", async () => {
    const g = parseGraph({
      ...graph,
      capabilities: graph.capabilities.map(({ price: _, ...c }) => c),
    });
    const b = await emitBundle({
      graph: g,
      lock: await approve(g, { get_usage_report: "approved" }),
      site,
      pages,
    });
    expect(b.mcp.tools.default.map((t) => t.name)).toEqual(["execute", "search"]);
    expect(b.mcp.payments).toBeUndefined();
  });

  it("carries the payments config once a priced capability is approved (P1)", () => {
    expect(bundle.mcp.payments).toEqual({ ...site.payments, maxTimeoutSeconds: 60 });
  });

  it("requires payments once a priced capability is approved", async () => {
    const { payments: _, ...noPayments } = site;
    await expect(emitBundle({ graph, lock, site: noPayments, pages })).rejects.toThrow(
      /site.payments/,
    );
  });

  it("refuses payment configs that break P4 or P5", async () => {
    for (const change of [{ market: "IN" }, { network: "eip155:8453" }]) {
      const bad = { ...site, payments: { ...site.payments, ...change } } as SiteConfigInput;
      await expect(emitBundle({ graph, lock, site: bad, pages })).rejects.toThrow(
        /AGENTS.md P[45]/,
      );
    }
  });

  it("requires authIssuer once an oauth capability is approved", async () => {
    const { authIssuer: _, ...noAuth } = site;
    await expect(emitBundle({ graph, lock, site: noAuth, pages })).rejects.toThrow(/authIssuer/);
  });

  it("requires apiOrigin once an http capability is approved", async () => {
    const { apiOrigin: _, ...noApi } = site;
    await expect(emitBundle({ graph, lock, site: noApi, pages })).rejects.toThrow(/apiOrigin/);
  });

  it("refuses prices the x402 rail cannot collect", async () => {
    const g = parseGraph({
      ...graph,
      capabilities: graph.capabilities.map((c) =>
        c.price ? { ...c, price: { amount: "1", currency: "INR" } } : c,
      ),
    });
    await expect(
      emitBundle({
        graph: g,
        lock: await approve(g, { get_usage_report: "approved" }),
        site,
        pages,
      }),
    ).rejects.toThrow(/charges in USD.*get_usage_report/);
  });

  it("refuses paid writes that outlast the payment window", async () => {
    const g = parseGraph({
      ...graph,
      capabilities: graph.capabilities.map((c) =>
        c.price && c.executor.kind === "http"
          ? { ...c, sideEffect: "write", executor: { ...c.executor, timeoutMs: 30_000 } }
          : c,
      ),
    });
    await expect(
      emitBundle({
        graph: g,
        lock: await approve(g, { get_usage_report: "approved" }),
        site: {
          ...site,
          payments: { ...(site.payments as object), maxTimeoutSeconds: 30 } as never,
        },
        pages,
      }),
    ).rejects.toThrow(/maxTimeoutSeconds \(30\).*get_usage_report/);
  });

  it("refuses to publish browser capabilities before the browser executor ships", async () => {
    const [base] = graph.capabilities.filter((c) => c.id === "search_docs") as [Capability];
    const browser: Capability = {
      ...base,
      executor: { kind: "browser", workflow: "docs-search", workflowVersion: 1 },
    };
    const g = { ...graph, capabilities: [browser] };
    await expect(
      emitBundle({ graph: g, lock: await approve(g, { search_docs: "approved" }), site, pages }),
    ).rejects.toThrow(/browser capabilities.*search_docs/);
  });

  it("tells the skill reader which actions are their own tools", async () => {
    const skill = artifact(bundle, "/.well-known/agent-skills/acme/SKILL.md").body;
    // The priced read is its own tool (the price shows before the call), not behind execute.
    expect(skill).toContain("the `get_usage_report` tool");
    expect(skill).not.toMatch(/get_usage_report` tool \(destructiveHint/);
    expect(skill).toContain("Each priced, write or destructive action is its own tool");
    const [cancel] = graph.capabilities.filter((c) => c.id === "cancel_subscription");
    const g = { ...graph, capabilities: [cancel as Capability] };
    const out = await emitBundle({
      graph: g,
      lock: await approve(g, { cancel_subscription: "approved" }),
      site,
      pages,
    });
    expect(artifact(out, "/.well-known/agent-skills/acme/SKILL.md").body).toContain(
      "the `cancel_subscription` tool (destructiveHint: true)",
    );
  });
});

describe("OAuth protected resource metadata (RFC 9728)", () => {
  it("describes the MCP endpoint at the path-inserted URL", () => {
    const prm = JSON.parse(artifact(bundle, "/.well-known/oauth-protected-resource/mcp").body);
    expect(prm).toEqual({
      resource: "https://acme.test/mcp",
      authorization_servers: ["https://auth.acme.test"],
      scopes_supported: ["usage:read"],
      bearer_methods_supported: ["header"],
      resource_name: "Acme",
    });
  });

  it("describes the origin itself at the bare well-known URL (RFC 9728 §3.3)", () => {
    const prm = JSON.parse(artifact(bundle, "/.well-known/oauth-protected-resource").body);
    expect(prm.resource).toBe("https://acme.test");
    expect(prm.authorization_servers).toEqual(["https://auth.acme.test"]);
    expect(bundle.aliases["/.well-known/oauth-protected-resource"]).toBeUndefined();
  });

  it("links the skill to the metadata whose resource is the MCP endpoint", () => {
    const skill = artifact(bundle, "/.well-known/agent-skills/acme/SKILL.md").body;
    expect(skill).toContain(
      "- Sign-in metadata: https://acme.test/.well-known/oauth-protected-resource/mcp\n",
    );
  });

  it("gives the MCP runtime its audience and metadata URL", () => {
    expect(bundle.mcp.auth).toEqual({
      issuer: "https://auth.acme.test",
      resource: "https://acme.test/mcp",
      resourceMetadataUrl: "https://acme.test/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("is absent when the site has no authorization server", async () => {
    const plain = await emitBundle({
      graph,
      lock: await approve(graph, {}),
      site: { ...site, authIssuer: undefined },
      pages,
    });
    expect(plain.artifacts.some((a) => a.path.includes("oauth-protected-resource"))).toBe(false);
    expect(plain.mcp.auth).toBeUndefined();
  });
});
