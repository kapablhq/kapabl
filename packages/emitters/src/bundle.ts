// SPDX-License-Identifier: Apache-2.0
// A bundle is everything the edge serves for one tenant, generated in one pass from the
// graph, the lockfile and the site config. Only lockfile-approved capabilities appear.

import {
  Capability,
  DEFAULT_ORIGIN_TIMEOUT_MS,
  emittableCapabilities,
  graphDigest,
  parseGraph,
  parseLockfile,
  prettyCanonicalJson,
  sha256Text,
  TenantId,
} from "@kapabl/graph";
import {
  CONFIRMATION_ALLOWANCE_SECONDS,
  PaymentsConfig,
  paymentWindowSeconds,
  VERIFY_ALLOWANCE_SECONDS,
} from "@kapabl/graph/payments";
import { z } from "zod";
import { Pages, SiteConfig, type SiteConfigInput } from "./config.ts";
import {
  aiCatalog,
  apiCatalog,
  contentSignal,
  MEDIA_TYPES,
  protectedResourceMetadata,
  robotsTxt,
  serverCard,
  sitemapXml,
} from "./discovery.ts";
import { llmsTxt } from "./llms-txt.ts";
import { mcpTools, ToolSurface } from "./mcp-tools.ts";
import { agentSkill } from "./skills.ts";
import {
  absolute,
  markdownPath,
  PATHS,
  PROTECTED_RESOURCE_PREFIX,
  protectedResourcePath,
  SERVER_CARD_ALIASES,
  serverCardPath,
} from "./urls.ts";

export const BUNDLE_FORMAT_VERSION = 1;

const SitePath = z.string().regex(/^\/[\x21-\x7E]*$/, "must be an absolute path");

export const Artifact = z.strictObject({
  path: SitePath,
  contentType: z.string().min(1),
  /** `page`: a human page (short cache). `discovery`: public metadata (CORS, long cache). */
  kind: z.enum(["page", "discovery"]),
  body: z.string(),
  /** Strong ETag: the quoted sha256 hex of `body`. */
  etag: z.string().regex(/^"[0-9a-f]{64}"$/),
  /** `Link` header value to send with this artifact. */
  link: z.string().min(1).optional(),
  /** For HTML pages: the path of the Markdown twin served for `Accept: text/markdown`. */
  markdown: SitePath.optional(),
});

/** What the MCP endpoint serves: identity, approved capabilities and the tool surface. */
export const McpRuntime = z.strictObject({
  server: z.strictObject({ name: z.string(), version: z.string(), title: z.string() }),
  origin: z.string(),
  mcpPath: SitePath,
  apiOrigin: z.string().optional(),
  /** Present when the endpoint is an OAuth resource server (AGENTS.md A1). */
  auth: z
    .strictObject({
      issuer: z.string(),
      /** RFC 8707 resource identifier: the token audience. */
      resource: z.string(),
      /** RFC 9728 metadata URL, advertised in every 401 and 403 challenge. */
      resourceMetadataUrl: z.string(),
    })
    .optional(),
  /** Present when a priced capability is approved: the rail and the tenant's wallet. */
  payments: PaymentsConfig.optional(),
  capabilities: z.array(Capability),
  tools: ToolSurface,
});

export const Bundle = z
  .strictObject({
    bundleVersion: z.literal(BUNDLE_FORMAT_VERSION),
    tenant: TenantId,
    graphDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** `Content-Signal` header value for pages. */
    contentSignal: z.string().min(1),
    artifacts: z.array(Artifact),
    mcp: McpRuntime,
    /** Extra paths that serve an artifact: `.html.md` suffixes, card compatibility aliases. */
    aliases: z.record(SitePath, SitePath),
  })
  .superRefine((bundle, ctx) => {
    const paths = new Set(bundle.artifacts.map((a) => a.path));
    if (paths.size !== bundle.artifacts.length) {
      ctx.addIssue({ code: "custom", message: "duplicate artifact path", path: ["artifacts"] });
    }
    for (const artifact of bundle.artifacts) {
      if (artifact.markdown !== undefined && !paths.has(artifact.markdown)) {
        ctx.addIssue({ code: "custom", message: `missing twin ${artifact.markdown}` });
      }
    }
    for (const [alias, target] of Object.entries(bundle.aliases)) {
      if (paths.has(alias) || !paths.has(target)) {
        ctx.addIssue({ code: "custom", message: `bad alias ${alias} -> ${target}` });
      }
    }
  });

export type Artifact = z.infer<typeof Artifact>;
export type Bundle = z.infer<typeof Bundle>;
export type McpRuntime = z.infer<typeof McpRuntime>;

export interface BundleInput {
  graph: unknown;
  lock: unknown;
  site: SiteConfigInput;
  pages: unknown;
}

function link(target: string, rel: string, type?: string): string {
  return `<${target}>; rel="${rel}"${type ? `; type="${type}"` : ""}`;
}

export async function emitBundle(input: BundleInput): Promise<Bundle> {
  const site = SiteConfig.parse(input.site);
  const pages = Pages.parse(input.pages);
  const graph = parseGraph(input.graph);
  const capabilities = await emittableCapabilities(graph, parseLockfile(input.lock));
  if (!pages.some((page) => page.path === "/")) throw new Error('pages must include "/"');
  if (!site.apiOrigin && capabilities.some((c) => c.executor.kind === "http")) {
    throw new Error("site.apiOrigin is required once an http capability is approved");
  }
  if (!site.authIssuer && capabilities.some((c) => c.auth.kind === "oauth")) {
    throw new Error("site.authIssuer is required once an oauth capability is approved");
  }
  if (!site.payments && capabilities.some((c) => c.price)) {
    throw new Error("site.payments is required once a priced capability is approved");
  }
  // x402 charges USDC, so it can only collect prices in USD; anything else would fail on
  // every call instead of at build time.
  const unpayable = capabilities.filter((c) => c.price && c.price.currency !== "USD");
  if (site.payments?.rail === "x402" && unpayable.length > 0) {
    throw new Error(
      `the x402 rail charges in USD; priced in another currency: ${unpayable.map((c) => c.id).join(", ")}`,
    );
  }
  // Clients sign payments valid for maxTimeoutSeconds from when they sign, and some of that
  // is gone on arrival (and during a confirmation round): a paid write's window must fit
  // strictly inside, or every payment for it would be turned away.
  if (site.payments) {
    const window = PaymentsConfig.parse(site.payments).maxTimeoutSeconds;
    const short = capabilities.filter(
      (c) =>
        c.price &&
        c.sideEffect !== "read" &&
        c.executor.kind === "http" &&
        paymentWindowSeconds(c.executor.timeoutMs ?? DEFAULT_ORIGIN_TIMEOUT_MS) +
          VERIFY_ALLOWANCE_SECONDS +
          (c.sideEffect === "destructive" ? CONFIRMATION_ALLOWANCE_SECONDS : 0) >
          window,
    );
    if (short.length > 0) {
      throw new Error(
        `payments.maxTimeoutSeconds (${window}) is shorter than these paid writes need: ${short.map((c) => c.id).join(", ")}`,
      );
    }
  }
  // v0.1 runs http capabilities only; a browser one would be listed and then fail every call.
  const browser = capabilities.filter((c) => c.executor.kind !== "http");
  if (browser.length > 0) {
    throw new Error(
      `browser capabilities cannot be published until the browser executor ships: ${browser.map((c) => c.id).join(", ")}`,
    );
  }
  for (const page of pages) {
    if (page.path === site.mcpPath || page.path.startsWith(`${site.mcpPath}/`)) {
      throw new Error(`page "${page.path}" would shadow the MCP endpoint ${site.mcpPath}`);
    }
  }

  const artifacts: Omit<Artifact, "etag">[] = [];
  const json = (path: string, contentType: string, value: unknown, link?: string) => {
    artifacts.push({
      path,
      contentType,
      kind: "discovery",
      body: prettyCanonicalJson(value),
      ...(link ? { link } : {}),
    });
  };
  const text = (path: string, contentType: string, body: string) => {
    artifacts.push({ path, contentType, kind: "discovery", body });
  };

  const skill = await agentSkill(site, graph.tenant, capabilities);
  const cardPath = serverCardPath(site);
  const card = serverCard(site);
  const cardDigest = await sha256Text(prettyCanonicalJson(card));

  json(cardPath, MEDIA_TYPES.serverCard, card);
  json(
    PATHS.aiCatalog,
    MEDIA_TYPES.aiCatalog,
    aiCatalog(site, graph.tenant, { digest: cardDigest }, skill),
  );
  json(
    PATHS.apiCatalog,
    MEDIA_TYPES.apiCatalog,
    apiCatalog(site, skill.path),
    link(PATHS.apiCatalog, "api-catalog"),
  );
  json(PATHS.skillsIndex, "application/json", skill.index);
  text(skill.path, "text/markdown; charset=utf-8", skill.body);
  text(PATHS.llmsTxt, "text/plain; charset=utf-8", llmsTxt(site, pages, capabilities, skill.path));
  text(PATHS.robotsTxt, "text/plain; charset=utf-8", robotsTxt(site));
  text(PATHS.sitemap, "application/xml", sitemapXml(site, pages));
  const prmPath = protectedResourcePath(site);
  if (site.authIssuer) {
    json(
      prmPath,
      "application/json",
      protectedResourceMetadata(site, site.authIssuer, capabilities),
    );
    // The bare well-known URL describes the origin itself (RFC 9728 §3.3), not the endpoint.
    json(
      PROTECTED_RESOURCE_PREFIX,
      "application/json",
      protectedResourceMetadata(site, site.authIssuer, capabilities, site.origin),
    );
  }

  // Discovery links for every page, in either representation (RFC 8288, llmstxt.org).
  const discoveryLinks = [
    link(PATHS.llmsTxt, "describedby", "text/plain"),
    link(PATHS.apiCatalog, "api-catalog"),
    link(cardPath, "service-desc", MEDIA_TYPES.serverCard),
  ];
  const aliases: Record<string, string> = {};
  for (const alias of SERVER_CARD_ALIASES) aliases[alias] = cardPath;
  for (const page of pages) {
    const mdPath = markdownPath(page.path);
    artifacts.push({
      path: mdPath,
      contentType: "text/markdown; charset=utf-8",
      kind: "page",
      body: page.markdown,
      link: discoveryLinks.join(", "),
    });
    aliases[mdPath.replace(/\.md$/, ".html.md")] = mdPath;
    if (page.html !== undefined) {
      artifacts.push({
        path: page.path,
        contentType: "text/html; charset=utf-8",
        kind: "page",
        body: page.html,
        link: [link(mdPath, "alternate", "text/markdown"), ...discoveryLinks].join(", "),
        markdown: mdPath,
      });
      if (page.path === "/") aliases["/index.html"] = "/";
    }
  }

  const withEtags = await Promise.all(
    artifacts.map(async (a) => ({ ...a, etag: `"${(await sha256Text(a.body)).slice(7)}"` })),
  );
  return Bundle.parse({
    bundleVersion: BUNDLE_FORMAT_VERSION,
    tenant: graph.tenant,
    graphDigest: await graphDigest(graph),
    contentSignal: contentSignal(site),
    artifacts: withEtags.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    mcp: {
      server: { name: site.serverName, version: site.version, title: site.name },
      origin: site.origin,
      mcpPath: site.mcpPath,
      ...(site.apiOrigin ? { apiOrigin: site.apiOrigin } : {}),
      ...(site.authIssuer
        ? {
            auth: {
              issuer: site.authIssuer,
              resource: absolute(site, site.mcpPath),
              resourceMetadataUrl: absolute(site, prmPath),
            },
          }
        : {}),
      ...(site.payments && capabilities.some((c) => c.price) ? { payments: site.payments } : {}),
      capabilities,
      tools: mcpTools(capabilities),
    },
    aliases,
  });
}
