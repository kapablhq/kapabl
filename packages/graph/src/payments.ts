// SPDX-License-Identifier: Apache-2.0
// A tenant's payment settings, as they sit in the site config and the bundle. No rail code
// is imported here, so the emitters can validate config without pulling in x402.
//
// The rules live in the schema, so a bad config fails at build time, not at the first call:
// payments go to the tenant's own wallet (P1), India gets no stablecoin rail (P4), and
// nothing but testnets until a fintech lawyer signs off in writing (P5).

import { z } from "zod";

/** CAIP-2 ids the x402 rail knows. Only testnets are accepted for now (P5). */
export const X402_NETWORKS = {
  "eip155:84532": { name: "Base Sepolia", testnet: true },
  "eip155:8453": { name: "Base", testnet: false },
} as const;

export const DEV_FACILITATOR_URL = "https://x402.org/facilitator";

const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be an EVM address (0x + 40 hex characters)")
  .refine((a) => !/^0x0{40}$/.test(a), "must not be the zero address");

export const X402Config = z
  .strictObject({
    rail: z.literal("x402"),
    /** Where the tenant is regulated. India has no stablecoin rail (P4). */
    market: z.enum(["US", "IN"]),
    network: z.enum(Object.keys(X402_NETWORKS) as [keyof typeof X402_NETWORKS]),
    /** The tenant's own wallet. Kapabl never receives or forwards funds (P1). */
    payTo: EvmAddress,
    /** Config, never hard-coded (P3): x402.org for testnet, CDP in production. */
    facilitatorUrl: z.url({ protocol: /^https$/ }),
    /** How long a signed payment stays valid. */
    maxTimeoutSeconds: z.int().min(10).max(600).default(60),
  })
  .superRefine((config, ctx) => {
    if (config.market === "IN") {
      ctx.addIssue({
        code: "custom",
        path: ["market"],
        message: "x402 settles in stablecoins, which Indian tenants must not use (AGENTS.md P4)",
      });
    }
    if (!X402_NETWORKS[config.network].testnet) {
      ctx.addIssue({
        code: "custom",
        path: ["network"],
        message:
          "real-money payments need a fintech lawyer's written sign-off first (AGENTS.md P5)",
      });
    }
  });

export const PaymentsConfig = X402Config;
export type PaymentsConfig = z.infer<typeof PaymentsConfig>;
export type PaymentsConfigInput = z.input<typeof PaymentsConfig>;

/**
 * A payment for a write must outlast the call's timeout by this much: it settles after,
 * and settling may take the facilitator's whole timeout (20 s) plus clock skew.
 */
export const PAYMENT_MARGIN_SECONDS = 25;

/** How long a payment for a write must stay valid, given the call's timeout. */
export function paymentWindowSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000) + PAYMENT_MARGIN_SECONDS;
}

/**
 * Time a payment spends before the edge can check it: the trip from the signing client
 * and the facilitator's verify round trip.
 */
export const VERIFY_ALLOWANCE_SECONDS = 10;

/** Time a person may take to confirm a paid destructive call, out of the payment's life. */
export const CONFIRMATION_ALLOWANCE_SECONDS = 15;
