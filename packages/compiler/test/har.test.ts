// SPDX-License-Identifier: Apache-2.0
// HAR → pending capabilities (AGENTS.md H2, H3), from the same scrubbed fixture.

import { readFileSync } from "node:fs";
import { Capability, sha256Text } from "@kapabl/graph";
import { describe, expect, it } from "vitest";
import { compileHar, templatePath } from "../src/har.ts";
import { scrubHar } from "../src/scrub.ts";
import { PLANTED } from "./planted.ts";

const raw = JSON.parse(readFileSync(new URL("./fixtures/acme.har", import.meta.url), "utf8"));
const result = await compileHar(raw);
const byId = new Map(result.capabilities.map((c) => [c.id, c]));

describe("templatePath", () => {
  it.each([
    ["/api/v1/invoices/inv_8f3a9c21", "/api/v1/invoices/{invoice_id}"],
    ["/api/v1/webhooks/48213", "/api/v1/webhooks/{webhook_id}"],
    [
      "/orgs/3f2b1c4d-0000-4000-8000-000000000001/categories/77",
      "/orgs/{org_id}/categories/{category_id}",
    ],
    ["/files/a1b2c3d4e5f6a7b8", "/files/{file_id}"],
    ["/api/v1/invoices", "/api/v1/invoices"],
    ["/api/v2/status", "/api/v2/status"],
    ["/12/34", "/{id}/{id_2}"],
    // Words joined by an underscore are not prefixed ids: they keep their meaning.
    ["/api/bulk_delete", "/api/bulk_delete"],
    ["/v1/payment_intents/pi_3MtwBwLkdIwHu7ix28a3tqPa", "/v1/payment_intents/{payment_intent_id}"],
    ["/users/[email]/orders", "/users/{user_id}/orders"],
    // A short prefixed id still has a digit.
    ["/api/v1/invoices/inv_8f3a/refund", "/api/v1/invoices/{invoice_id}/refund"],
  ])("%s → %s", (path, template) => {
    expect(templatePath(path).template).toBe(template);
  });
});

describe("compileHar", () => {
  it("compiles the API host's actions, sorted and deterministic", async () => {
    expect(result.apiOrigin).toBe("https://app.acme.test");
    expect(result.capabilities.map((c) => c.id)).toEqual([
      "update_account",
      "list_integrations",
      "list_invoices",
      "get_invoice",
      "refund_invoice",
      "delete_webhook",
    ]);
    expect(JSON.stringify(await compileHar(raw))).toBe(JSON.stringify(result));
  });

  it("lists the HTML pages the capture opened, with ids templated", async () => {
    expect(result.pages).toEqual(["https://app.acme.test/"]);
    const login = structuredClone(raw);
    const page = login.log.entries[0];
    login.log.entries.push(
      { ...page, request: { ...page.request, url: "https://app.acme.test/login" } },
      { ...page, request: { ...page.request, url: "https://app.acme.test/invoices/inv_8f3a2b9c" } },
    );
    expect((await compileHar(login)).pages).toEqual([
      "https://app.acme.test/",
      "https://app.acme.test/invoices/{invoice_id}",
    ]);
  });

  it("every capability is a valid, pending graph capability with provenance (H2, H3)", async () => {
    const capture = await sha256Text(JSON.stringify(scrubHar(raw).har));
    expect(result.capture).toBe(capture);
    for (const c of result.capabilities) {
      expect(Capability.safeParse(c).success).toBe(true);
      expect(c.approval).toBe("pending");
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThan(1);
      expect(c.provenance).toMatchObject({ source: "har", capture });
    }
  });

  it("classifies side effects: GET read, refund and DELETE destructive, PATCH write", () => {
    expect(byId.get("list_invoices")?.sideEffect).toBe("read");
    expect(byId.get("get_invoice")?.sideEffect).toBe("read");
    expect(byId.get("refund_invoice")?.sideEffect).toBe("destructive");
    expect(byId.get("delete_webhook")?.sideEffect).toBe("destructive");
    expect(byId.get("update_account")?.sideEffect).toBe("write");
  });

  it("credentialed calls need a signed-in user and an exchanged token, never the agent's (A2)", () => {
    const refund = byId.get("refund_invoice");
    expect(refund?.auth).toEqual({ kind: "oauth", scopes: ["invoices:write"] });
    expect(refund?.executor).toEqual({
      kind: "http",
      method: "POST",
      path: "/api/v1/invoices/{invoice_id}/refund",
      credential: { kind: "token-exchange", audience: "https://app.acme.test" },
    });
  });

  it("infers inputs from path, query and body; PATCH and query inputs are optional", () => {
    expect(byId.get("get_invoice")?.inputSchema).toEqual({
      type: "object",
      properties: { invoice_id: { type: "string" } },
      required: ["invoice_id"],
      additionalProperties: false,
    });
    expect(byId.get("list_invoices")?.inputSchema).toEqual({
      type: "object",
      properties: { limit: { type: "integer" }, status: { type: "string" } },
      additionalProperties: false,
    });
    const refund = byId.get("refund_invoice")?.inputSchema as {
      required: string[];
      properties: object;
    };
    // One captured refund: its body fields are inputs, but only the path variable is required.
    expect(refund.required).toEqual(["invoice_id"]);
    expect(Object.keys(refund.properties)).toEqual(["invoice_id", "amount", "note", "reason"]);
    expect(byId.get("update_account")?.inputSchema.required).toBeUndefined();
  });

  it("merges samples into an output schema; a field missing from one sample is optional", () => {
    const output = byId.get("get_invoice")?.outputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(output.properties.id).toEqual({ type: "string" });
    expect(Object.keys(output.properties).length).toBeGreaterThan(1);
  });

  it("skips sign-in endpoints, form bodies, other hosts, pages and assets", () => {
    expect(result.skipped).toEqual([
      { method: "POST", path: "/api/v1/login", reason: "sign-in endpoints are never exposed" },
      {
        method: "POST",
        path: "/api/v1/exports",
        reason: "the request body is not JSON (form bodies are not supported yet)",
      },
    ]);
    const paths = result.capabilities.map((c) =>
      c.executor.kind === "http" ? c.executor.path : "",
    );
    expect(paths.some((p) => p.endsWith(".js") || p === "/")).toBe(false);
  });

  it("no planted secret or personal value reaches a capability (H1)", () => {
    const out = JSON.stringify(result.capabilities);
    for (const secret of PLANTED) expect(out).not.toContain(secret);
  });

  it("takes an explicit API origin", async () => {
    const other = await compileHar(raw, { apiOrigin: "https://nowhere.test/ignored" });
    expect(other.apiOrigin).toBe("https://nowhere.test");
    expect(other.capabilities).toEqual([]);
  });

  it("rejects a capture with no JSON API calls, and non-HAR input", async () => {
    await expect(compileHar({ log: { entries: [] } })).rejects.toThrow(/no JSON API/);
    await expect(compileHar({})).rejects.toThrow(/not a HAR/);
  });

  it("requires body fields that every one of two or more samples had", async () => {
    const post = (body: object) => ({
      request: {
        method: "POST",
        url: "https://api.x.test/notes",
        headers: [],
        postData: { mimeType: "application/json", text: JSON.stringify(body) },
      },
      response: { status: 201, content: { mimeType: "application/json", text: "{}" } },
    });
    const r = await compileHar({
      log: { entries: [post({ text: "a", pinned: true }), post({ text: "b" })] },
    });
    expect(r.capabilities[0]?.inputSchema.required).toEqual(["text"]);
  });

  it("reads what a write does from action fields, not from free text", async () => {
    const write = (method: string, path: string, body: object) => ({
      request: {
        method,
        url: `https://api.x.test${path}`,
        headers: [],
        postData: { mimeType: "application/json", text: JSON.stringify(body) },
      },
      response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
    });
    const r = await compileHar({
      log: {
        entries: [
          write("POST", "/comments", { text: "Can you send the deck?" }),
          write("PATCH", "/tickets/12", { note: "customer wants to cancel later maybe" }),
          write("POST", "/search", { filter: "archived" }),
          write("PATCH", "/subscriptions/7", { status: "cancelled" }),
          write("PATCH", "/files/1", { deleted: true }),
          write("PATCH", "/projects/1", { archived: true }),
          write("POST", "/subs/1", { cancel_at_period_end: true }),
          write("POST", "/orders/1/actions", { action: "Cancel order" }),
        ],
      },
    });
    expect(Object.fromEntries(r.capabilities.map((c) => [c.id, c.sideEffect]))).toEqual({
      actions_order: "destructive",
      create_comments: "write",
      create_search: "write",
      create_sub: "destructive",
      update_file: "destructive",
      update_project: "destructive",
      update_subscription: "destructive",
      update_ticket: "write",
    });
  });

  it("skips sign-in verification but keeps business verify and callback actions", async () => {
    const post = (path: string) => ({
      request: { method: "POST", url: `https://api.x.test${path}`, headers: [] },
      response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
    });
    const r = await compileHar({
      log: {
        entries: [
          "/api/payments/verify",
          "/api/addresses/verify",
          "/api/webhooks/callback",
          "/api/devices/register",
          "/api/cards/token",
          "/api/v1/verify",
          "/auth/refresh",
          "/users/me/email/verify",
          "/api/register",
          "/users/me/password",
        ].map(post),
      },
    });
    expect(r.capabilities.map((c) => c.executor.kind === "http" && c.executor.path)).toEqual([
      "/api/addresses/verify",
      "/api/cards/token",
      "/api/devices/register",
      "/api/payments/verify",
      "/api/webhooks/callback",
    ]);
    expect(r.skipped.map((s) => s.path).sort()).toEqual([
      "/api/register",
      "/api/v1/verify",
      "/auth/refresh",
      "/users/me/email/verify",
      "/users/me/password",
    ]);
  });

  it("skips a group with no successful response", async () => {
    const failed = await compileHar({
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://api.x.test/things", headers: [] },
            response: { status: 500, content: { mimeType: "application/json", text: "{}" } },
          },
        ],
      },
    });
    expect(failed.skipped).toEqual([
      { method: "GET", path: "/things", reason: "no successful response was captured" },
    ]);
  });

  it("keeps destructive words that look like ids, and sends a body method's query inputs in the query", async () => {
    const r = await compileHar({
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: "https://api.x.test/api/bulk_delete?dry_run=true",
              headers: [],
              postData: { mimeType: "application/json", text: '{"ids":["a"]}' },
            },
            response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
          },
        ],
      },
    });
    const [c] = r.capabilities;
    expect(c?.sideEffect).toBe("destructive");
    expect(c?.executor).toMatchObject({ path: "/api/bulk_delete", query: ["dry_run"] });
    expect(Object.keys(c?.inputSchema.properties ?? {})).toEqual(["dry_run", "ids"]);
    expect(r.examples[c?.id ?? ""]).toEqual({ dry_run: true, ids: ["a"] });
  });

  it("accepts an empty success for a write and reports one that is not JSON", async () => {
    const entry = (path: string, response: Record<string, unknown>) => ({
      request: { method: "POST", url: `https://api.x.test${path}`, headers: [] },
      response: { status: 202, content: { mimeType: "", size: 0 }, ...response },
    });
    const r = await compileHar(
      {
        log: {
          entries: [
            entry("/jobs/7/archive", {}),
            entry("/jobs/7/ping", { content: { mimeType: "text/plain", text: "OK" } }),
          ],
        },
      },
      { apiOrigin: "https://api.x.test" },
    );
    expect(r.capabilities.map((c) => c.executor.kind === "http" && c.executor.path)).toEqual([
      "/jobs/{job_id}/archive",
    ]);
    expect(r.skipped).toEqual([
      {
        method: "POST",
        path: "/jobs/{job_id}/ping",
        reason: "the response is text/plain, not JSON",
      },
    ]);
  });

  it("keeps redacted values' types in schemas, and never uses them as examples", async () => {
    const r = await compileHar({
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: "https://api.x.test/cards",
              headers: [{ name: "Authorization", value: "Bearer x" }],
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({ label: "work", zip: 94107 }),
              },
            },
            response: {
              status: 201,
              content: {
                mimeType: "application/json",
                text: JSON.stringify({ id: "c_1", pin: 1234, contacts: [{ name: "Jane" }] }),
              },
            },
          },
        ],
      },
    });
    const [c] = r.capabilities;
    expect(c?.inputSchema.properties).toEqual({
      label: { type: "string" },
      zip: { type: "integer" },
    });
    expect((c?.outputSchema?.properties as Record<string, unknown> | undefined)?.pin).toEqual({
      type: "integer",
    });
    expect(r.examples[c?.id ?? ""]).toEqual({ label: "work" });
  });

  it("skips OAuth callbacks and one-URL GraphQL or RPC endpoints", async () => {
    const call = (method: string, url: string) => ({
      request: { method, url, headers: [] },
      response: { status: 200, content: { mimeType: "application/json", text: '{"ok":true}' } },
    });
    const r = await compileHar({
      log: {
        entries: [
          call("GET", "https://api.x.test/auth/callback?code=OAUTHCODE123&state=xyz"),
          call("POST", "https://api.x.test/graphql"),
          call("GET", "https://api.x.test/notes"),
        ],
      },
    });
    expect(r.capabilities.map((c) => c.id)).toEqual(["list_notes"]);
    expect(r.skipped.map((s) => `${s.method} ${s.path}`).sort()).toEqual([
      "GET /auth/callback",
      "POST /graphql",
    ]);
    expect(JSON.stringify(r)).not.toContain("OAUTHCODE123");
  });

  it("names a skipped sign-in path by its template, not the captured path", async () => {
    const r = await compileHar({
      log: {
        entries: [
          {
            request: {
              method: "POST",
              url: "https://api.x.test/session/a1b2c3d4e5f6a7b8c9d0",
              headers: [],
            },
            response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
          },
        ],
      },
    });
    expect(r.skipped).toEqual([
      {
        method: "POST",
        path: "/session/{session_id}",
        reason: "sign-in endpoints are never exposed",
      },
    ]);
  });
});
