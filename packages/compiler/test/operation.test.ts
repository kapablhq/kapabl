// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  dedupeIds,
  idFor,
  type Operation,
  sideEffectOf,
  singular,
  toCapability,
} from "../src/operation.ts";

const op = (
  method: Operation["method"],
  path: string,
  extra: Partial<Operation> = {},
): Operation => ({
  method,
  path,
  pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1] as string,
    schema: { type: "string" },
    required: true,
  })),
  query: [],
  security: { kind: "none" },
  ...extra,
});
const options = {
  source: { kind: "openapi", document: `sha256:${"a".repeat(64)}` },
  apiOrigin: "https://api.x.test",
  confidence: 0.9,
} as const;

describe("idFor", () => {
  it.each([
    [op("GET", "/api/v1/invoices"), "list_invoices"],
    [op("GET", "/api/v1/invoices/{invoice_id}"), "get_invoice"],
    [op("POST", "/api/v1/invoices"), "create_invoices"],
    [op("POST", "/invoices/{invoice_id}/refund"), "refund_invoice"],
    [op("PUT", "/categories/{id}"), "replace_category"],
    [op("DELETE", "/webhooks/{id}"), "delete_webhook"],
    [op("GET", "/x", { operationId: "listPetsByOwner" }), "list_pets_by_owner"],
    [op("GET", "/x", { operationId: "search" }), "search_action"],
    [op("GET", "/x", { operationId: "2fa-status" }), "op_2fa_status"],
  ])("%j → %s", (operation, id) => {
    expect(idFor(operation)).toBe(id);
  });

  it("caps ids at 64 characters", () => {
    expect(idFor(op("GET", "/x", { operationId: "a".repeat(80) })).length).toBe(64);
  });
});

describe("singular", () => {
  it.each([
    ["invoices", "invoice"],
    ["categories", "category"],
    ["status", "status"],
    ["address", "address"],
    ["analysis", "analysis"],
  ])("%s → %s", (noun, one) => {
    expect(singular(noun)).toBe(one);
  });
});

describe("sideEffectOf (H2)", () => {
  it.each([
    [op("GET", "/payments"), "read"],
    [op("DELETE", "/x/{id}"), "destructive"],
    [op("POST", "/orders/{id}/cancel"), "destructive"],
    [op("POST", "/payouts"), "destructive"],
    [op("POST", "/x", { operationId: "voidCharge" }), "destructive"],
    [op("POST", "/x", { summary: "Transfer funds" }), "destructive"],
    [op("POST", "/notes"), "write"],
    [op("PATCH", "/account"), "write"],
    // Word by word: joined and camelCase names count, words that merely contain one do not.
    [op("POST", "/v1/payment_intents"), "destructive"],
    [op("POST", "/v1/payment_intents/{id}/capture"), "destructive"],
    [op("POST", "/orders/{id}/pay_now"), "destructive"],
    [op("POST", "/checkout"), "destructive"],
    [op("POST", "/x", { operationId: "createPurchase" }), "destructive"],
    [op("POST", "/payroll/runs"), "destructive"],
    [op("POST", "/accounts/{id}/close-account"), "destructive"],
    [op("POST", "/webhooks/payload"), "write"],
    [op("POST", "/tips/avoid"), "write"],
    [op("PUT", "/patients/{id}/discharge"), "write"],
    [op("PUT", "/refunds_policy/{refund_id}"), "destructive"],
    // Every form of a destructive word counts.
    [op("POST", "/subscriptions/{id}/cancellations"), "destructive"],
    [op("POST", "/account/deletion"), "destructive"],
    [op("POST", "/subscriptions/{id}/deactivation"), "destructive"],
    [op("POST", "/files/{id}/trash"), "destructive"],
    [op("POST", "/wallet/send"), "destructive"],
    [op("POST", "/checkouts/{id}/complete"), "destructive"],
    [op("POST", "/accounts/{id}/close"), "destructive"],
    [op("POST", "/users/{id}/suspend"), "destructive"],
    [op("POST", "/keys/{id}/rotate"), "destructive"],
    // Creating an order is a purchase; updating one is not.
    [op("POST", "/orders"), "destructive"],
    [op("PATCH", "/orders/{id}"), "write"],
    [op("POST", "/tickets/{id}/close"), "write"],
    // A GET that names a destructive verb is destructive; a list of payments is not.
    [op("GET", "/items/{id}/delete"), "destructive"],
    [op("GET", "/unsubscribe"), "destructive"],
    [op("GET", "/transfers"), "read"],
    // Only the last path word or the operationId's verb: these GETs are lists and pages.
    [op("GET", "/v1/checkout/sessions"), "read"],
    [op("GET", "/x", { operationId: "GetCheckoutSessions" }), "read"],
    [op("GET", "/archive"), "read"],
    [op("GET", "/trash"), "read"],
    [op("GET", "/api/send-history"), "read"],
    [op("GET", "/transfer/{id}"), "read"],
    [op("GET", "/x", { operationId: "cancelOrder" }), "destructive"],
    // Any word of the last literal segment, file extension aside.
    [op("GET", "/cancel-order"), "destructive"],
    [op("GET", "/deleteUser"), "destructive"],
    [op("GET", "/subscriptions/{id}/cancel_subscription"), "destructive"],
    [op("GET", "/api/orders/1/delete.json"), "destructive"],
    [op("GET", "/x", { operationId: "getRefundStatus" }), "read"],
    [op("GET", "/x", { operationId: "orderCancel" }), "destructive"],
    // An action on one item, even when the word alone could name a list.
    [op("GET", "/api/files/{id}/trash"), "destructive"],
    [op("GET", "/api/v1/accounts/{id}/close"), "destructive"],
    [op("GET", "/api/users/{id}/ban"), "destructive"],
    [op("GET", "/accounts/{id}/transfer"), "destructive"],
    [op("GET", "/charges/{id}/reverse"), "destructive"],
    [op("GET", "/keys/{id}/rotate"), "destructive"],
    [op("GET", "/x", { operationId: "transferFunds" }), "destructive"],
    [op("GET", "/x", { operationId: "chargeCustomer" }), "destructive"],
    // Values seen in captured bodies count: this PATCH cancels.
    [op("PATCH", "/subscriptions/{id}", { hints: ["cancelled"] }), "destructive"],
    [op("POST", "/api/rpc2", { hints: ["users.delete"] }), "destructive"],
  ])("%j → %s", (operation, effect) => {
    expect(sideEffectOf(operation)).toBe(effect);
  });
});

describe("dedupeIds", () => {
  it("never makes a suffixed id that another operation already has", () => {
    const base = toCapability(op("GET", "/a"), options);
    if ("reason" in base) throw new Error(base.reason);
    const named = (id: string) => ({ ...base, id });
    expect(dedupeIds([named("get_a"), named("get_a"), named("get_a_2")]).map((c) => c.id)).toEqual([
      "get_a",
      "get_a_3",
      "get_a_2",
    ]);
  });
});

describe("toCapability", () => {
  it("never asks an agent for a secret: sensitive inputs are dropped", () => {
    const c = toCapability(
      op("POST", "/notes", {
        security: { kind: "user", scopes: ["notes:write"] },
        body: {
          type: "object",
          properties: {
            text: { type: "string" },
            csrf_token: { type: "string" },
            password: { type: "string" },
          },
          required: ["text", "csrf_token"],
        },
      }),
      options,
    );
    expect("inputSchema" in c && c.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
  });

  it("skips an anonymous operation that requires a secret input", () => {
    const c = toCapability(
      op("GET", "/x", { query: [{ name: "api_key", schema: { type: "string" }, required: true }] }),
      options,
    );
    expect(c).toEqual({
      method: "GET",
      path: "/x",
      reason: 'needs "api_key", which agents must never supply',
    });
  });

  it("an anonymous destructive action still requires a signed-in user", () => {
    const c = toCapability(op("DELETE", "/carts/{cart_id}"), options);
    expect("auth" in c && c.auth).toEqual({ kind: "oauth", scopes: ["carts:write"] });
    expect("executor" in c && c.executor).toMatchObject({ credential: { kind: "none" } });
  });

  it("an API-key API uses the tenant's stored secret, named after the scheme", () => {
    const c = toCapability(
      op("GET", "/x", { security: { kind: "api-key", scheme: "partnerKey" } }),
      options,
    );
    expect("executor" in c && c.executor).toMatchObject({
      credential: { kind: "tenant-secret", secretRef: "TENANT_PARTNER_KEY" },
    });
  });

  it("keeps declared scopes and the operation's own words", () => {
    const c = toCapability(
      op("GET", "/pets", {
        security: { kind: "user", scopes: ["pets:read"] },
        summary: "List pets",
        description: "All pets.",
        operationId: "listPets",
      }),
      options,
    );
    expect(c).toMatchObject({
      id: "list_pets",
      title: "List pets",
      description: "All pets.",
      auth: { kind: "oauth", scopes: ["pets:read"] },
      provenance: { source: "openapi", operationId: "listPets", method: "GET", path: "/pets" },
      confidence: 0.9,
    });
  });

  it("skips HEAD and duplicate inputs", () => {
    expect(toCapability(op("HEAD", "/x"), options)).toMatchObject({ reason: /HEAD/ });
    const clash = toCapability(
      op("GET", "/x/{id}", {
        query: [{ name: "id", schema: { type: "string" }, required: false }],
      }),
      options,
    );
    expect(clash).toMatchObject({ reason: 'input "id" appears twice' });
  });
});
