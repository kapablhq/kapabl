// SPDX-License-Identifier: Apache-2.0
// Capability text shown to people: the reviewer's terminal and the action audit page.

import type { Capability } from "@kapabl/graph";

/**
 * Text from a source, made safe to print: control characters, bidirectional overrides and
 * zero-width characters are shown as escapes, so a description cannot rewrite or hide
 * what the reviewer sees in the terminal.
 */
export function printable(text: string): string {
  return text.replace(
    /(?!\n)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

/** Which credential reaches the site's API for a call (never the agent's token, AGENTS.md A2). */
export function credentialText(c: Capability): string {
  if (c.executor.kind !== "http") return "n/a";
  const credential = c.executor.credential;
  if (credential.kind === "none") return "none";
  if (credential.kind === "token-exchange") {
    return `a token for the signed-in user, issued for ${credential.audience}`;
  }
  const placement = credential.placement ?? { in: "authorization", scheme: "bearer" };
  const where =
    placement.in === "authorization"
      ? `as ${placement.scheme === "basic" ? "Basic" : "Bearer"} authorization`
      : `in the ${placement.in} "${placement.name}"`;
  return `the site's secret ${credential.secretRef}, sent ${where}`;
}
