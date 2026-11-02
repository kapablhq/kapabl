// SPDX-License-Identifier: Apache-2.0
// Site-level discovery documents: MCP server card, AI Catalog, API Catalog (RFC 9727),
// robots.txt with Content Signals, and sitemap.xml.

import type { Capability } from "@kapabl/graph";
import type { Page, SiteConfig } from "./config.ts";
import { xmlText } from "./text.ts";
import { absolute, MCP_PROTOCOL_VERSIONS, PATHS, serverCardPath } from "./urls.ts";
import type { ServerCard } from "./vendor/server-card.ts";

export const SERVER_CARD_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

export const MEDIA_TYPES = {
  serverCard: "application/mcp-server-card+json",
  aiCatalog: "application/ai-catalog+json",
  apiCatalog: 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  skillMd: "application/agent-skills+md",
} as const;

/** Server card (ext-server-card v1). Identity and transport only: cards never list tools. */
export function serverCard(site: SiteConfig): ServerCard {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: site.serverName,
    version: site.version,
    title: site.name,
    description: site.summary,
    websiteUrl: absolute(site, "/"),
    ...(site.repository ? { repository: site.repository } : {}),
    remotes: [
      {
        type: "streamable-http",
        url: absolute(site, site.mcpPath),
        supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS],
      },
    ],
  };
}

/** One AI Catalog entry (github.com/Agent-Card/ai-catalog, spec 1.0). */
export interface AiCatalogEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  digest: string;
}

export interface AiCatalog {
  specVersion: "1.0";
  host: { displayName: string; identifier: string };
  entries: AiCatalogEntry[];
}

/**
 * AI Catalog for /.well-known/ai-catalog.json. Since ADR-0016 the spec makes entry
 * displayName optional and says to omit it when the artifact names itself, but Cloudflare's
 * Agent Readiness ARD check still requires it. Each value is copied from the same source as
 * the artifact's own name (card title, skill name), so the two cannot drift. Entries still
 * omit description.
 */
export function aiCatalog(
  site: SiteConfig,
  tenant: string,
  card: { digest: string },
  skill: { name: string; path: string; digest: string },
): AiCatalog {
  const publisher = new URL(site.origin).hostname;
  return {
    specVersion: "1.0",
    host: { displayName: site.name, identifier: publisher },
    entries: [
      {
        identifier: `urn:air:${publisher}:mcp:${tenant}`,
        displayName: site.name,
        type: MEDIA_TYPES.serverCard,
        url: absolute(site, serverCardPath(site)),
        digest: card.digest,
      },
      {
        identifier: `urn:air:${publisher}:skill:${skill.name}`,
        displayName: skill.name,
        type: MEDIA_TYPES.skillMd,
        url: absolute(site, skill.path),
        digest: skill.digest,
      },
    ],
  };
}

interface LinkTarget {
  href: string;
  type?: string;
}

/** RFC 9727 API catalog as an RFC 9264 linkset: the MCP endpoint is the API. */
export function apiCatalog(site: SiteConfig, skillPath: string): { linkset: object[] } {
  const mcpUrl = absolute(site, site.mcpPath);
  const item: LinkTarget[] = [{ href: mcpUrl }];
  const serviceDesc: LinkTarget[] = [
    { href: absolute(site, serverCardPath(site)), type: MEDIA_TYPES.serverCard },
  ];
  const serviceDoc: LinkTarget[] = [{ href: absolute(site, skillPath), type: "text/markdown" }];
  return {
    linkset: [
      { anchor: absolute(site, PATHS.apiCatalog), item },
      { anchor: mcpUrl, "service-desc": serviceDesc, "service-doc": serviceDoc },
    ],
  };
}

/** `Content-Signal` value, used in robots.txt and as a response header (AGENTS.md D3). */
export function contentSignal(site: SiteConfig): string {
  const yn = (value: boolean) => (value ? "yes" : "no");
  const { aiTrain, search, aiInput } = site.contentSignals;
  return `ai-train=${yn(aiTrain)}, search=${yn(search)}, ai-input=${yn(aiInput)}`;
}

export function robotsTxt(site: SiteConfig): string {
  return [
    "User-agent: *",
    `Content-Signal: ${contentSignal(site)}`,
    "Allow: /",
    "",
    `Sitemap: ${absolute(site, PATHS.sitemap)}`,
    "",
  ].join("\n");
}

export function sitemapXml(site: SiteConfig, pages: readonly Page[]): string {
  const urls = pages.map((page) => `  <url><loc>${xmlText(absolute(site, page.path))}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * RFC 9728 Protected Resource Metadata (AGENTS.md A1). `resource` is the MCP endpoint for the
 * path-inserted document, and the site's origin for the bare one (RFC 9728 §3.3: a document's
 * `resource` must be the identifier its well-known URL was built from).
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
}

export function protectedResourceMetadata(
  site: SiteConfig,
  issuer: string,
  capabilities: readonly Capability[],
  resource: string = absolute(site, site.mcpPath),
): ProtectedResourceMetadata {
  const scopes = [
    ...new Set(capabilities.flatMap((c) => (c.auth.kind === "oauth" ? c.auth.scopes : []))),
  ].sort();
  return {
    resource,
    authorization_servers: [issuer],
    ...(scopes.length > 0 ? { scopes_supported: scopes } : {}),
    bearer_methods_supported: ["header"],
    resource_name: site.name,
  };
}
