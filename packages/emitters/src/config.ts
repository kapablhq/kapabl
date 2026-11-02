// SPDX-License-Identifier: Apache-2.0
// Inputs the emitters need beyond the capability graph: where the site lives, how it
// names itself, and its public pages. Everything emitted is derived from these and the
// approved capabilities, never hand-edited (AGENTS.md D2).

import { PaymentsConfig } from "@kapabl/graph/payments";
import { z } from "zod";

/** Display text: must contain something other than whitespace. */
const DisplayText = (max: number) => z.string().min(1).max(max).regex(/\S/, "must not be blank");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `https://host[:port]` with no path, query or trailing slash. Plain http only for local dev. */
export const Origin = z.string().refine(
  (value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    const secure =
      url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
    return secure && url.origin === value;
  },
  { message: "must be an https origin with no path or trailing slash (http only for localhost)" },
);

/** Absolute site path of a public page: `/` or lowercase segments, no trailing slash. */
export const PagePath = z
  .string()
  .regex(/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/, "must be / or /lowercase-segments");

export const SiteConfig = z.strictObject({
  origin: Origin,
  /** Display name: the server card `title`, llms.txt H1 and AI Catalog host name. */
  name: DisplayText(100),
  /** One-line summary: the server card `description` and llms.txt blockquote. */
  summary: DisplayText(100),
  /** Reverse-DNS MCP server name, e.g. `com.example/app` (server card `name`). */
  serverName: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/, "must be reverse-DNS namespace/name"),
  /** Semantic version of the agent surface, e.g. `0.1.0`. Ranges are not versions. */
  version: z
    .string()
    .regex(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      "must be a semantic version",
    ),
  /** Origin that http capabilities call (the tenant's API). Required once any are approved. */
  apiOrigin: Origin.optional(),
  /** OAuth Authorization Server issuer (apps/auth). Required once an oauth capability is approved. */
  /** How priced capabilities are paid for (AGENTS.md P1-P5). Required once one is approved. */
  payments: PaymentsConfig.optional(),
  authIssuer: Origin.optional(),
  mcpPath: z
    .string()
    .regex(/^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/, "must be /segments with no trailing slash")
    .default("/mcp"),
  repository: z
    .strictObject({ url: z.url({ protocol: /^https$/ }), source: z.string().min(1) })
    .optional(),
  /** Content Signals (contentsignals.org): how the site's content may be used. */
  contentSignals: z.strictObject({
    aiTrain: z.boolean(),
    search: z.boolean(),
    aiInput: z.boolean(),
  }),
});

export const Page = z.strictObject({
  path: PagePath,
  title: DisplayText(200),
  description: DisplayText(500),
  /** The page as Markdown: served for `Accept: text/markdown` and at the `.md` URL. */
  markdown: z.string().min(1),
  /** The page as a full HTML document, when Kapabl serves the page itself (dogfood site). */
  html: z.string().min(1).optional(),
});

export const Pages = z
  .array(Page)
  .min(1)
  .superRefine((pages, ctx) => {
    const seen = new Set<string>();
    pages.forEach((page, index) => {
      if (seen.has(page.path)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate page "${page.path}"`,
          path: [index, "path"],
        });
      }
      seen.add(page.path);
    });
  });

export type SiteConfig = z.infer<typeof SiteConfig>;
export type SiteConfigInput = z.input<typeof SiteConfig>;
export type Page = z.infer<typeof Page>;
