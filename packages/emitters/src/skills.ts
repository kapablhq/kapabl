// SPDX-License-Identifier: Apache-2.0
// Agent Skills discovery (cloudflare/agent-skills-discovery-rfc v0.2.0): one SKILL.md per
// tenant, stating how to reach its MCP server and what each approved action does.
// The text is reference data, never instructions to the agent (AGENTS.md D5).

import { type Capability, prettyCanonicalJson, sha256Text } from "@kapabl/graph";
import type { SiteConfig } from "./config.ts";
import { ownTool } from "./mcp-tools.ts";
import { codeBlock, inlineCode, inlineMarkdown } from "./text.ts";
import {
  absolute,
  MCP_PROTOCOL_VERSIONS,
  PATHS,
  protectedResourcePath,
  serverCardPath,
  skillPath,
} from "./urls.ts";

export const SKILLS_INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** agentskills.io name rule: 1-64 of a-z, 0-9 and single inner hyphens. */
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillsIndex {
  $schema: string;
  skills: { name: string; type: "skill-md"; description: string; url: string; digest: string }[];
}

export interface Skill {
  name: string;
  path: string;
  body: string;
  digest: string;
  index: SkillsIndex;
}

function signIn(capability: Capability): string {
  return capability.auth.kind === "oauth"
    ? `OAuth 2.1, scopes ${capability.auth.scopes.map(inlineCode).join(", ")}`
    : "not required";
}

function actionSection(capability: Capability): string {
  // The same rule as the tool surface: priced reads are their own tools too.
  const tool = !ownTool(capability)
    ? "listed by the `search` tool and run by the `execute` tool"
    : capability.sideEffect === "read"
      ? `the \`${capability.id}\` tool`
      : `the \`${capability.id}\` tool (destructiveHint: true)`;
  const lines = [
    `### ${inlineMarkdown(capability.title)}`,
    "",
    inlineMarkdown(capability.description),
    "",
    `- Id: \`${capability.id}\``,
    `- Effect: ${capability.sideEffect}`,
    `- Tool: ${tool}`,
    `- Sign-in: ${signIn(capability)}`,
  ];
  if (capability.price) {
    lines.push(`- Price: ${capability.price.amount} ${capability.price.currency} per call`);
  }
  lines.push("- Input schema:", "", codeBlock(prettyCanonicalJson(capability.inputSchema), "json"));
  return lines.join("\n");
}

export function skillMarkdown(
  site: SiteConfig,
  name: string,
  description: string,
  capabilities: readonly Capability[],
): string {
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
  ];
  const connection = [
    "## Connection",
    "",
    `- MCP endpoint: ${absolute(site, site.mcpPath)} (Streamable HTTP, stateless)`,
    `- Protocol versions: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
    `- Server card: ${absolute(site, serverCardPath(site))}`,
    `- API catalog: ${absolute(site, PATHS.apiCatalog)}`,
  ];
  if (capabilities.some((c) => c.auth.kind === "oauth")) {
    // The path-inserted URL (RFC 9728 §3.1): its `resource` is the MCP endpoint.
    connection.push(`- Sign-in metadata: ${absolute(site, protectedResourcePath(site))}`);
  }
  const actions =
    capabilities.length === 0
      ? ["## Actions", "", "No actions are published yet."]
      : [
          "## Actions",
          "",
          "Read actions are reached through the `search` and `execute` tools. Each priced, write or destructive action is its own tool, named by its id.",
          "",
          capabilities.map(actionSection).join("\n\n"),
        ];
  return [
    ...frontmatter,
    "",
    `# ${inlineMarkdown(site.name)}`,
    "",
    inlineMarkdown(site.summary),
    "",
    ...connection,
    "",
    ...actions,
    "",
  ].join("\n");
}

/** The tenant's skill plus its v0.2.0 discovery index (digest = sha256 of the SKILL.md bytes). */
export async function agentSkill(
  site: SiteConfig,
  tenant: string,
  capabilities: readonly Capability[],
): Promise<Skill> {
  if (!SKILL_NAME.test(tenant)) {
    throw new Error(`tenant "${tenant}" is not a valid Agent Skills name`);
  }
  const description = `${site.name} MCP server: how to connect, and the ${capabilities.length} action(s) it exposes to agents.`;
  const path = skillPath(tenant);
  const body = skillMarkdown(site, tenant, description, capabilities);
  const digest = await sha256Text(body);
  return {
    name: tenant,
    path,
    body,
    digest,
    index: {
      $schema: SKILLS_INDEX_SCHEMA,
      skills: [{ name: tenant, type: "skill-md", description, url: path, digest }],
    },
  };
}
