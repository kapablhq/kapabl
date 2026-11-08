// SPDX-License-Identifier: Apache-2.0
// Where each generated artifact is served. One place, so links between artifacts agree.

import type { SiteConfig } from "./config.ts";

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25"] as const;

export const PATHS = {
  aiCatalog: "/.well-known/ai-catalog.json",
  apiCatalog: "/.well-known/api-catalog",
  skillsIndex: "/.well-known/agent-skills/index.json",
  llmsTxt: "/llms.txt",
  robotsTxt: "/robots.txt",
  sitemap: "/sitemap.xml",
} as const;

/** Compatibility aliases for the server card (AGENTS.md M9). Scanners still probe these. */
export const SERVER_CARD_ALIASES = ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json"];

/** RFC 9728 §3.1: the well-known prefix is inserted before the resource's path. */
export const PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";

export function protectedResourcePath(site: SiteConfig): string {
  return `${PROTECTED_RESOURCE_PREFIX}${site.mcpPath}`;
}

export function serverCardPath(site: SiteConfig): string {
  return `${site.mcpPath}/server-card`;
}

export function skillPath(skillName: string): string {
  return `/.well-known/agent-skills/${skillName}/SKILL.md`;
}

/** `/` → `/index.md`, `/pricing` → `/pricing.md` (llmstxt.org convention). */
export function markdownPath(pagePath: string): string {
  return pagePath === "/" ? "/index.md" : `${pagePath}.md`;
}

export function absolute(site: SiteConfig, path: string): string {
  return `${site.origin}${path}`;
}
