// SPDX-License-Identifier: Apache-2.0
// /llms.txt (llmstxt.org): H1, summary blockquote, then H2 lists of links.

import type { Capability } from "@kapabl/graph";
import type { Page, SiteConfig } from "./config.ts";
import { inlineMarkdown } from "./text.ts";
import { absolute, markdownPath, PATHS, serverCardPath } from "./urls.ts";

function item(title: string, url: string, notes: string): string {
  return `- [${inlineMarkdown(title)}](${url}): ${inlineMarkdown(notes)}`;
}

export function llmsTxt(
  site: SiteConfig,
  pages: readonly Page[],
  capabilities: readonly Capability[],
  skillPath: string,
): string {
  const sections = [
    `# ${inlineMarkdown(site.name)}`,
    "",
    `> ${inlineMarkdown(site.summary)}`,
    "",
    "## Pages",
    "",
    ...pages.map((page) =>
      item(page.title, absolute(site, markdownPath(page.path)), page.description),
    ),
    "",
    "## Agent interfaces",
    "",
    item(
      "MCP server card",
      absolute(site, serverCardPath(site)),
      `MCP server at ${absolute(site, site.mcpPath)}`,
    ),
    item("Agent skill", absolute(site, skillPath), "Connection details and every published action"),
    item("API catalog", absolute(site, PATHS.apiCatalog), "RFC 9727 list of this site's APIs"),
  ];
  if (capabilities.length > 0) {
    sections.push(
      "",
      "## Actions",
      "",
      ...capabilities.map((c) =>
        item(c.title, absolute(site, skillPath), `${c.sideEffect}. ${c.description}`),
      ),
    );
  }
  sections.push("");
  return sections.join("\n");
}
