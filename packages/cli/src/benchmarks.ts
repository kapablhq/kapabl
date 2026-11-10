// SPDX-License-Identifier: Apache-2.0
// What the audit compares a reader's numbers with. Every figure here was measured, by
// Cloudflare or by this CLI, and each block says by whom, when and how to redo it. Raw
// counts are kept, never rounded shares, so the page computes what it shows.

/** The checks the website audit reports, by the key Cloudflare's scanner gives them. */
export const SITE_CHECKS = [
  "robotsTxt",
  "sitemap",
  "linkHeaders",
  "markdownNegotiation",
  "robotsTxtAiRules",
  "contentSignals",
  "mcpServerCard",
  "ard",
  "apiCatalog",
  "agentSkills",
  "oauthProtectedResource",
] as const;
export type SiteCheck = (typeof SITE_CHECKS)[number];

type Counts = readonly [
  sites: number,
  robotsTxt: number,
  sitemap: number,
  linkHeaders: number,
  markdownNegotiation: number,
  robotsTxtAiRules: number,
  contentSignals: number,
  mcpServerCard: number,
  ard: number,
  apiCatalog: number,
  agentSkills: number,
  oauthProtectedResource: number,
];

/**
 * Cloudflare Radar, "Adoption of AI agent standards": how many of the most visited sites
 * pass each check, by Cloudflare's own category for the site. Read from
 * radar.cloudflare.com/ai-insights (the chart's "Domain category" filter); Cloudflare
 * updates it weekly. `sites` is how many sites of that category were scanned.
 */
export const RADAR = {
  source: "Cloudflare Radar, Adoption of AI agent standards",
  url: "https://radar.cloudflare.com/ai-insights#adoption-of-ai-agent-standards",
  date: "2026-11-09",
  categories: {
    all: [
      "all categories",
      [117018, 100740, 83731, 11454, 5202, 97717, 10887, 744, 360, 921, 751, 4463],
    ],
    personal: ["Personal Blogs", [2497, 1991, 1625, 320, 82, 1912, 256, 10, 1, 9, 9, 32]],
    arts: ["Arts", [774, 685, 562, 91, 25, 671, 75, 1, 0, 2, 0, 66]],
    photography: ["Photography", [1053, 915, 620, 68, 45, 888, 143, 2, 1, 4, 2, 49]],
    business: [
      "Business & Economy",
      [24515, 21253, 19462, 3597, 1523, 20679, 1858, 287, 135, 339, 273, 635],
    ],
    technology: [
      "Technology",
      [45480, 37082, 32883, 5727, 3084, 36052, 3797, 658, 306, 820, 660, 744],
    ],
    shop: ["Ecommerce", [19437, 18358, 15975, 1736, 1094, 18113, 1936, 74, 36, 97, 71, 3447]],
    education: ["Education", [18804, 15840, 11781, 1452, 544, 14757, 1689, 46, 30, 58, 36, 218]],
    news: ["News & Media", [7304, 6835, 5827, 717, 221, 6666, 530, 22, 11, 27, 19, 30]],
    health: ["Health", [3904, 3494, 3090, 470, 189, 3388, 317, 12, 3, 13, 8, 177]],
    travel: ["Travel", [6924, 6210, 5096, 540, 294, 6068, 518, 58, 10, 44, 90, 38]],
    "real-estate": ["Real Estate", [3786, 3456, 2938, 362, 186, 3382, 404, 22, 10, 32, 32, 26]],
    jobs: ["Job Search & Careers", [2796, 2598, 2014, 190, 106, 2552, 216, 28, 14, 18, 14, 2]],
    food: ["Food & Drink", [1586, 1429, 1211, 234, 66, 1388, 154, 5, 1, 8, 4, 141]],
    entertainment: [
      "Entertainment",
      [25153, 22300, 18194, 2190, 765, 21696, 2640, 75, 36, 104, 64, 288],
    ],
    nonprofit: ["Charity and Non-profit", [602, 519, 454, 128, 23, 508, 53, 2, 1, 2, 1, 6]],
  } satisfies Record<string, readonly [name: string, counts: Counts]>,
} as const;

export type SiteCategory = keyof typeof RADAR.categories;

/** How many sites of a category were scanned, and how many of them pass a check. */
export function radarShare(
  category: SiteCategory,
  check: SiteCheck,
): { sites: number; pass: number } {
  const counts: Counts = RADAR.categories[category][1];
  return { sites: counts[0], pass: counts[SITE_CHECKS.indexOf(check) + 1] as number };
}

/**
 * This CLI's own audit, run on the public OpenAPI documents of well-known products as the
 * APIs.guru directory listed them on the date below. Twenty were picked before measuring;
 * the four where fewer than ten requests became actions are left out, since a share of so
 * few says nothing. To redo it: `kapabl audit --openapi FILE` on each document.
 */
export const PUBLIC_APIS = {
  source: "kapabl audit on public OpenAPI documents from the APIs.guru directory",
  date: "2026-11-10",
  apis: [
    ["Asana", 166, 79, 59, 28],
    ["Bitbucket", 288, 159, 82, 47],
    ["Box", 218, 100, 70, 48],
    ["DigitalOcean", 263, 139, 68, 56],
    ["DocuSign", 365, 156, 119, 90],
    ["GitHub", 791, 426, 224, 141],
    ["Jira Cloud", 457, 215, 156, 86],
    ["Linode", 326, 152, 112, 62],
    ["Notion", 13, 7, 5, 1],
    ["Postman", 57, 23, 26, 8],
    ["Slack", 91, 45, 35, 11],
    ["Square", 199, 84, 76, 39],
    ["Stripe", 136, 77, 35, 24],
    ["Twilio", 199, 104, 60, 35],
    ["Vercel", 105, 51, 31, 23],
    ["Zoom", 354, 170, 118, 66],
  ] satisfies readonly (readonly [
    name: string,
    actions: number,
    reads: number,
    writes: number,
    destructive: number,
  ])[],
} as const;

/** The lowest, middle and highest value of a measure across the public APIs. */
export function publicApiSpread(measure: (api: (typeof PUBLIC_APIS.apis)[number]) => number): {
  low: number;
  median: number;
  high: number;
} {
  const values = PUBLIC_APIS.apis.map(measure).sort((a, b) => a - b);
  const middle = values.length / 2;
  return {
    low: values[0] as number,
    median:
      ((values[Math.floor(middle - 0.5)] as number) + (values[Math.ceil(middle - 0.5)] as number)) /
      2,
    high: values.at(-1) as number,
  };
}
