// SPDX-License-Identifier: Apache-2.0
// AGENTS.md H1: this fixture proves scrubbing ran. Every secret and piece of personal data
// planted in test/fixtures/acme.har must be gone, and the structure the compiler needs
// (methods, paths, field names, non-sensitive values) must survive.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCredentialName, isSensitiveName, scrubHar } from "../src/scrub.ts";
import { PLANTED } from "./planted.ts";

const raw = JSON.parse(readFileSync(new URL("./fixtures/acme.har", import.meta.url), "utf8"));
const { har, report } = scrubHar(raw);
const out = JSON.stringify(har);

describe("scrubHar", () => {
  it("the raw fixture really contains every planted secret", () => {
    const input = JSON.stringify(raw);
    for (const secret of PLANTED) expect(input).toContain(secret);
  });

  it.each(PLANTED)("removes %s", (secret) => {
    expect(out).not.toContain(secret);
  });

  it("drops credential headers, cookies and query parameters", () => {
    for (const entry of har.log.entries) {
      const names = [...entry.request.headers, ...entry.response.headers].map((h) =>
        h.name.toLowerCase(),
      );
      expect(names).not.toContain("cookie");
      expect(names).not.toContain("set-cookie");
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("x-csrf-token");
      expect(entry.request.cookies).toEqual([]);
      expect(entry.response.cookies).toEqual([]);
      expect(entry.request.url).not.toMatch(/api_key/);
    }
  });

  it("keeps what inference needs", () => {
    const urls = har.log.entries.map((e) => `${e.request.method} ${e.request.url}`);
    expect(urls).toContain("GET https://app.acme.test/api/v1/invoices?status=open&limit=20");
    expect(urls).toContain("POST https://app.acme.test/api/v1/invoices/inv_8f3a2b9c/refund");
    const refund = har.log.entries.find((e) => e.request.url.endsWith("/refund"));
    expect(JSON.parse(refund?.request.postData?.text ?? "{}")).toEqual({
      amount: 4200,
      reason: "duplicate",
      note: "call [phone], card [card]",
    });
  });

  it("drops binary bodies, timings, IPs and page titles", () => {
    const avatar = har.log.entries.find((e) => e.request.url.endsWith("/avatar"));
    expect(avatar?.response.content.text).toBeUndefined();
    expect(har.log.pages).toBeUndefined();
  });

  it("records which requests carried credentials", () => {
    const authed = report.credentialed.map((i) => har.log.entries[i]?.request.url);
    expect(authed).toContain("https://app.acme.test/api/v1/invoices/inv_8f3a2b9c");
    expect(authed).not.toContain("https://app.acme.test/");
  });

  it("reports what it removed", () => {
    expect(report.entries).toBe(14);
    expect(report.headersDropped).toBeGreaterThan(30);
    expect(report.queryParamsDropped).toBe(1);
    // The HTML page, the script and the base64 avatar: nothing parseable, so nothing kept.
    expect(report.bodiesDropped).toBe(3);
    for (const kind of [
      "email",
      "jwt",
      "secret",
      "card",
      // The fixture's SSN sits under `tax_id`, a personal field, so it goes by name.
      "pan",
      "phone",
      "personal-field",
    ]) {
      expect(report.redactions).toHaveProperty(kind);
    }
  });

  it("refuses something that is not a HAR", () => {
    expect(() => scrubHar({ foo: 1 })).toThrow(/not a HAR/);
  });
});

describe("isSensitiveName", () => {
  it.each([
    "Authorization",
    "X-Auth-Token",
    "x-api-key",
    "api_key",
    "apiKey",
    "accesskey",
    "session",
    "session_id",
    "sessionId",
    "csrf_token",
    "password",
    "client_secret",
    "cardNumber",
    "pan",
    "aadhaar_no",
    "otp",
    "sig",
  ])("%s is a secret", (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each([
    "author",
    "authority",
    "passengers",
    "footprint",
    "session_count",
    "compass",
    "tokenizer_mode",
    "signup_source",
    "pinned",
    "keyword",
  ])("%s is not", (name) => {
    expect(isSensitiveName(name)).toBe(false);
  });
});

describe("scrubbing ordinary names", () => {
  it("keeps author and passengers and does not mark the request credentialed", () => {
    const { har, report } = scrubHar({
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://api.x.test/books?author=tolkien&passengers=2",
              headers: [],
            },
            response: {
              status: 200,
              content: { mimeType: "application/json", text: '{"author":"Tolkien"}' },
            },
          },
        ],
      },
    });
    expect(har.log.entries[0]?.request.url).toBe(
      "https://api.x.test/books?author=tolkien&passengers=2",
    );
    expect(har.log.entries[0]?.response.content.text).toBe('{"author":"Tolkien"}');
    expect(report.credentialed).toEqual([]);
  });
});

/** A one-request HAR. */
function one(request: Record<string, unknown>, response: Record<string, unknown> = {}) {
  return {
    log: {
      entries: [
        {
          request: { method: "GET", headers: [], ...request },
          response: {
            status: 200,
            content: { mimeType: "application/json", text: "{}" },
            ...response,
          },
        },
      ],
    },
  };
}

function scrubOne(request: Record<string, unknown>, response: Record<string, unknown> = {}) {
  const { har, report } = scrubHar(one(request, response));
  const entry = har.log.entries[0];
  if (!entry) throw new Error("entry dropped");
  return { entry, report, out: JSON.stringify(har) };
}

describe("URLs", () => {
  it("replaces PII and secrets in path segments with placeholders", () => {
    const { entry, out } = scrubOne({
      url: "https://api.x.test/users/jane.doe%40example.com/phones/%2B14155550100/keys/sk_live_abcdefgh12345678",
    });
    expect(new URL(entry.request.url).pathname).toBe("/users/[email]/phones/[phone]/keys/[secret]");
    for (const value of ["jane.doe", "4155550100", "sk_live"]) expect(out).not.toContain(value);
  });

  it("redacts whatever follows a segment named like a secret, but not a route name", () => {
    const { entry } = scrubOne({ url: "https://api.x.test/reset/token/abc123/confirm" });
    expect(new URL(entry.request.url).pathname).toBe("/reset/token/[redacted]/confirm");
    const route = scrubOne({ url: "https://api.x.test/auth/callback" });
    expect(new URL(route.entry.request.url).pathname).toBe("/auth/callback");
  });

  it("drops sensitive matrix parameters and counts the request as credentialed", () => {
    const { entry, report } = scrubOne({
      url: "https://api.x.test/app;jsessionid=ABC123DEF/orders;page=2",
    });
    expect(entry.request.url).toBe("https://api.x.test/app/orders;page=2");
    expect(report.credentialed).toEqual([0]);
  });

  it("scrubs query parameter names and treats personal parameters as personal", () => {
    const { entry, out } = scrubOne({
      url: "https://api.x.test/search?first_name=Jane&jane%40example.com=1&q=books",
    });
    expect(entry.request.queryString).toEqual([
      { name: "first_name", value: "[personal]" },
      { name: "[email]", value: "1" },
      { name: "q", value: "books" },
    ]);
    expect(out).not.toContain("Jane");
  });

  it("redacts JSON carried in a query value field by field", () => {
    const filter = JSON.stringify({ status: "open", token: "t0ps3cret" });
    const { out } = scrubOne({
      url: `https://api.x.test/list?filter=${encodeURIComponent(filter)}`,
    });
    expect(out).not.toContain("t0ps3cret");
    expect(out).toContain("open");
  });

  it("leaves out entries that are not http requests, or not entries at all", () => {
    const { har, report } = scrubHar({
      log: {
        entries: [
          null,
          { request: { method: "GET", url: "data:text/plain,hunter2" }, response: {} },
          { request: { method: "GET", url: "not a url" } },
          ...one({ url: "https://api.x.test/ok" }).log.entries,
        ],
      },
    });
    expect(har.log.entries.map((e) => e.request.url)).toEqual(["https://api.x.test/ok"]);
    expect(report.entriesDropped).toBe(3);
    expect(JSON.stringify(har)).not.toContain("hunter2");
  });
});

describe("headers", () => {
  it("keeps only Accept and Content-Type, so URLs and client addresses go too", () => {
    const { entry, report } = scrubOne({
      url: "https://api.x.test/a",
      headers: [
        { name: "Accept", value: "application/json" },
        { name: "Referer", value: "https://app.x.test/reset?token=abc" },
        { name: ":path", value: "/a?session=xyz" },
        { name: "X-Forwarded-For", value: "198.51.100.7" },
        { name: "User-Agent", value: "Mozilla/5.0" },
      ],
    });
    expect(entry.request.headers).toEqual([{ name: "Accept", value: "application/json" }]);
    expect(report.headersDropped).toBe(4);
    expect(report.credentialed).toEqual([]);
  });

  it.each(["X-CSRFToken", "X-Auth-Key", "Ocp-Apim-Subscription-Key", "X-Goog-Api-Key"])(
    "%s marks the request as credentialed",
    (name) => {
      const { report } = scrubOne({ url: "https://api.x.test/a", headers: [{ name, value: "v" }] });
      expect(report.credentialed).toEqual([0]);
    },
  );
});

describe("bodies", () => {
  const post = (text: string, mimeType = "application/json") =>
    scrubOne({ method: "POST", url: "https://api.x.test/a", postData: { mimeType, text } });

  it("redacts a sensitive key's whole value, whatever its type, keeping the type", () => {
    const { entry } = post(
      JSON.stringify({
        credentials: { user: "jane", key: "k" },
        tokens: ["a1", "b2"],
        pin: 1234,
        otp_verified: true,
      }),
    );
    expect(JSON.parse(entry.request.postData?.text ?? "")).toEqual({
      credentials: "[redacted:object]",
      tokens: "[redacted:array]",
      pin: "[redacted:integer]",
      otp_verified: "[redacted:boolean]",
    });
  });

  it("finds phone and card numbers stored as JSON numbers", () => {
    const { entry } = post(JSON.stringify({ contact: 9876543210, card: 4242424242424242, qty: 3 }));
    expect(JSON.parse(entry.request.postData?.text ?? "")).toEqual({
      contact: "[phone:integer]",
      card: "[card:integer]",
      qty: 3,
    });
  });

  it("treats names as personal: a top-level name, <person>_name, and one-word names", () => {
    const { entry } = post(
      JSON.stringify({
        name: "Jane Doe",
        cardholder_name: "Jane Doe",
        surname: "Doe",
        product: { name: "Widget" },
        company_name: "Acme",
      }),
    );
    expect(JSON.parse(entry.request.postData?.text ?? "")).toEqual({
      name: "[personal]",
      cardholder_name: "[personal]",
      surname: "[personal]",
      product: { name: "Widget" },
      company_name: "Acme",
    });
  });

  it.each([
    ["an XSSI guard", `)]}'\n${JSON.stringify({ password: "hunter2" })}`],
    ["newline-delimited JSON", `{"a":1}\n${JSON.stringify({ password: "hunter2" })}`],
    ["JSON inside a string", JSON.stringify({ payload: JSON.stringify({ password: "hunter2" }) })],
  ])("redacts JSON behind %s field by field", (_, text) => {
    const { out } = post(text);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[redacted]");
  });

  it("drops a body it cannot parse, keeping a marker that there was one", () => {
    const multipart =
      '--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--b--';
    const { entry, report, out } = post(multipart, "multipart/form-data; boundary=b");
    expect(entry.request.postData?.text).toBe("[dropped]");
    expect(report.bodiesDropped).toBe(1);
    expect(out).not.toContain("hunter2");
  });

  it("never keeps a file part's contents", () => {
    const { out } = scrubOne({
      method: "POST",
      url: "https://api.x.test/a",
      postData: {
        mimeType: "multipart/form-data",
        params: [
          { name: "title", value: "Report" },
          { name: "file", fileName: "id.png", value: "SECRETFILEBYTES" },
        ],
      },
    });
    expect(out).not.toContain("SECRETFILEBYTES");
    expect(out).toContain("Report");
  });

  it("drops response bodies that are not JSON, but remembers there was one", () => {
    const { entry } = scrubOne(
      { url: "https://api.x.test/page" },
      { content: { mimeType: "text/html", text: "<p>Jane Doe</p>" } },
    );
    expect(entry.response.content.text).toBeUndefined();
    expect(entry.response.content.size).toBeGreaterThan(0);
  });
});

describe("detection", () => {
  it.each(["+14155550100", "4155550100", "98765 43210", "+91-98765-43210", "415-555-0100"])(
    "finds the phone number %s",
    (phone) => {
      const { out } = scrubOne(
        { url: "https://api.x.test/a" },
        {
          content: {
            mimeType: "application/json",
            text: JSON.stringify({ note: `call ${phone}` }),
          },
        },
      );
      expect(out).toContain("call [phone]");
    },
  );

  it.each([
    "upi_pin",
    "atm_pin",
    "pwd",
    "cvv2",
    "security_code",
    "auth_key",
    "app_key",
    "X-CSRFToken",
    "refreshtoken",
    "newPassword",
  ])("%s is a secret", (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each(["pin_code", "payload", "monkey", "tokenizer", "keys_count"])(
    "%s is not a secret",
    (name) => {
      expect(isSensitiveName(name)).toBe(false);
    },
  );
});

/** Everything that survived scrubbing one entry, as text. */
const survives = (request: Record<string, unknown>) =>
  scrubOne({ method: "POST", url: "https://app.test/api/x", ...request }).out;

const jsonBody = (value: unknown) => ({
  postData: { mimeType: "application/json", text: JSON.stringify(value) },
});

describe("scrubHar, round 3 leaks", () => {
  it("judges a labeled pair by its most sensitive label", () => {
    const out = survives(
      jsonBody({ name: "Prod hook", header: "Authorization", value: "Basic dXNlcjpodW50ZXIy" }),
    );
    expect(out).not.toContain("dXNlcjpodW50ZXIy");
  });

  it("drops credentials in free text and link codes in queries", () => {
    const out = survives({
      url: "https://app.test/api/x?oobCode=Abc123def456&login_code=998877&ticket=ST-1-abc&reset_key=k9k9k9",
      ...jsonBody({
        cmd: "curl -H 'Authorization: Bearer 9f8e7d6c5b4a3f2e1d0c'",
        link: "https://app.test/go?t=a1b2c3d4e5f6g7h8i9",
      }),
    });
    for (const secret of ["Abc123def456", "998877", "ST-1-abc", "k9k9k9", "9f8e7d6c5b4a3f2e1d0c"])
      expect(out).not.toContain(secret);
    expect(out).not.toContain("a1b2c3d4e5f6g7h8i9");
  });

  it("scrubs a long value without an @ in linear time", () => {
    const started = performance.now();
    survives(jsonBody({ blob: "a.".repeat(100_000), more: "1-".repeat(100_000) }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("still finds emails and UPI handles", () => {
    const out = survives(jsonBody({ msg: "write to jane.doe@example.com or pay jane@okaxis" }));
    expect(out).not.toContain("jane");
  });
});

describe("scrubHar, round 4 leaks", () => {
  it.each([
    ["postgres://admin:S3cr3tpw@10.0.0.5:5432/app", "S3cr3tpw"],
    ["ftp://u:pw1234567@127.0.0.1/", "pw1234567"],
    ["postgres://admin:p4ss!w0rd#x@db.example.com/app", "p4ss!w0rd"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["BEARER abcdef123456789", "abcdef123456789"],
    ["/settings?email=jane%40example.com", "jane"],
    [`${"j".repeat(70)}@example.com`, "jjjj"],
  ])("drops the secret in %s", (text, secret) => {
    expect(survives(jsonBody({ text }))).not.toContain(secret);
  });

  it("leaves ordinary prose about tokens alone", () => {
    expect(survives(jsonBody({ text: "Token validation failed" }))).toContain("Token validation");
  });

  it("drops values under secret-looking names", () => {
    const body = {
      authorization_code: "AbC9xYz",
      sms_code: "482913",
      device_code: "GmRhmhcxhw",
      security_answer: "Fluffy",
      session_key: "s3ss10nk3y",
      STRIPE_KEY: "zzStripe99",
      merchant_salt: "pSaltValue",
      mnemonic: "abandon ability able",
    };
    const out = survives(jsonBody(body));
    for (const value of Object.values(body)) expect(out).not.toContain(value);
  });

  it("keeps public codes and keys", () => {
    const out = survives(
      jsonBody({ country_code: "IN", currency_code: "INR", idempotency_key: "k1" }),
    );
    for (const value of ["IN", "INR", "k1"]) expect(out).toContain(`\\"${value}\\"`);
  });

  it("judges labeled values by any label", () => {
    const out = survives(
      jsonBody({
        a: { label: "API key", value: "zq8xkkwlmp" },
        b: { title: "Secret", value: "titlesecret" },
        c: { type: "password", id: "pw", value: "hunter2" },
        d: { key: "STRIPE_KEY", value: "abcd1234efgh" },
      }),
    );
    for (const value of ["zq8xkkwlmp", "titlesecret", "hunter2", "abcd1234efgh"])
      expect(out).not.toContain(value);
  });

  it("drops link tokens under compound routes and base64 query tokens", () => {
    for (const url of [
      "https://api.x.test/verify-email/ab12cd34ef56gh78ij90",
      "https://api.x.test/invites/accept/ab12cd34ef56gh78ij90",
    ]) {
      expect(survives({ url })).not.toContain("ab12cd34ef56gh78ij90");
    }
    const out = survives({ url: "https://api.x.test/x?key2=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==" });
    expect(out).not.toContain("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA");
  });
});

describe("scrubHar, round 5 leaks", () => {
  it("drops secrets under <word>_pass, _auth, _pat names and in env pairs", () => {
    const out = survives({
      postData: {
        mimeType: "application/x-www-form-urlencoded",
        text: "smtp_pass=hunter2hunter&redis_auth=r3d1s99",
      },
    });
    expect(out).not.toContain("hunter2hunter");
    expect(out).not.toContain("r3d1s99");
    const env = survives(
      jsonBody({
        vars: [
          { key: "GITHUB_PAT", value: "ghpvalue123" },
          { key: "DB_PASS", value: "dbpw9" },
        ],
      }),
    );
    expect(env).not.toContain("ghpvalue123");
    expect(env).not.toContain("dbpw9");
  });

  it("still checks every sibling of a labeled value", () => {
    const out = survives(
      jsonBody({
        owner: { id: 9, name: "Raj Patel", value: 9 },
        cred: { name: "Prod", key: "f3a9c1d27e8b4f60", value: "x" },
      }),
    );
    expect(out).not.toContain("Raj Patel");
    expect(out).not.toContain("f3a9c1d27e8b4f60");
  });

  it.each([
    ['{"accept_url":"/invitations/accept?token=AbCdEf123456"}', "AbCdEf123456"],
    ["see //evil.example/?token=abc12345", "abc12345"],
    ["STRIPE_SECRET=whatever123\nAPI_KEY=abcd1234efgh", "abcd1234efgh"],
    ["password=hunter2xyz", "hunter2xyz"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", "MIIEabc"],
    [
      // Fake values, split so secret scanners do not take this file for a leak.
      `https://hooks.${"slack"}.com/services/T01ABCD2EFG/B02HIJK3LMN/aB3dE5fG7hI9jK1lM3nO5pQ7`,
      "aB3dE5fG7hI9",
    ],
  ])("drops the secret in free text %s", (text, secret) => {
    expect(survives(jsonBody({ text }))).not.toContain(secret);
  });

  it("splits long runs of capitals in linear time", () => {
    const started = performance.now();
    survives(jsonBody({ ["A".repeat(100_000)]: 1, x: { name: "B".repeat(100_000), value: 1 } }));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("scrubHar, round 6 leaks", () => {
  it.each([
    ['Validation failed for {"password":"hunter2","api_key":"k_9f8e7d6c5b4a"', "hunter2"],
    ['{"cvc":"123","token":"tok_abc123', "tok_abc123"],
    ["Authorization: ApiKey 9f8e7d6c5b4a3928", "9f8e7d6c5b4a3928"],
    ["curl -u admin:S3cr3tPass https://x.test", "S3cr3tPass"],
    ["cvv=123", "123"],
    ["Cookie: theme=dark; laravel_session=abcDEF123456; XSRF-TOKEN=abc", "abcDEF123456"],
    [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----",
      "lQOYBF",
    ],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowTRUNC", "MIIEowTRUNC"],
    [`shp${"at"}_0123456789abcdef0123456789abcdef`, "0123456789ab"],
  ])("drops the secret in %s", (text, secret) => {
    expect(survives(jsonBody({ text }))).not.toContain(secret);
  });

  it("drops session cookies named after the app", () => {
    for (const name of ["user_session", "laravel_session", "_myapp_session", "connect.sid"])
      expect(isSensitiveName(name)).toBe(true);
  });

  it("scrubs relative URLs in linear time, without recursing, leaving clean ones alone", () => {
    const started = performance.now();
    survives(jsonBody({ a: "=/".repeat(50_000), b: "/?".repeat(3_000) }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(survives(jsonBody({ link: "/a/{id}?flag" }))).toContain("/a/{id}?flag");
  });
});

describe("credential names", () => {
  it("leave ordinary inputs to agents", () => {
    for (const name of ["ticket", "key", "code", "page_token", "nextPageToken"])
      expect(isCredentialName(name)).toBe(false);
    for (const name of ["max_tokens", "projectKey", "plan_code", "signature_type", "tokens_used"])
      expect(isCredentialName(name)).toBe(false);
    for (const name of ["api_key", "password", "session_id", "client_secret", "x-csrf-token"])
      expect(isCredentialName(name)).toBe(true);
  });
});

describe("scrubHar, round 2 leaks", () => {
  it.each([
    [{ refresh: "opaqueRefresh123", access: "opaqueAccess456", sess: "abc987" }],
    [{ authHeader: "Bearer zzz-opaque" }],
    [{ code: "482913" }],
    [{ nonce: "n-0S6_WzA2Mj" }],
  ])("drops credential-named keys: %j", (body) => {
    const out = survives(jsonBody(body));
    for (const value of Object.values(body)) expect(out).not.toContain(value);
  });

  it("drops a password sent as a multipart field named pw", () => {
    const out = survives({
      postData: { mimeType: "multipart/form-data", params: [{ name: "pw", value: "hunter2" }] },
    });
    expect(out).not.toContain("hunter2");
  });

  it("scrubs the query of a URL inside a value", () => {
    const out = survives({
      url: "https://app.test/api/x?redirect_uri=https%3A%2F%2Fa.com%2Fcb%3Faccess_token%3DSECRETTOK",
      ...jsonBody({ next: "https://a.com/reset?token=opaqueRESET999&email=jane%40example.com" }),
    });
    expect(out).not.toContain("SECRETTOK");
    expect(out).not.toContain("opaqueRESET999");
    expect(out).not.toContain("jane");
  });

  it("judges a name/value pair's value by its name", () => {
    const out = survives(
      jsonBody({
        headers: [{ name: "Authorization", value: "Bearer opaqueTOKEN123456" }],
        fields: [{ name: "password", value: "hunter2" }],
      }),
    );
    expect(out).not.toContain("opaqueTOKEN123456");
    expect(out).not.toContain("hunter2");
  });

  it("redacts everything inside a personal object", () => {
    const out = survives(
      jsonBody({ address: { line1: "221B Baker Street" }, name: { first: "Jane", last: "Doe" } }),
    );
    for (const value of ["Baker", "Jane", "Doe"]) expect(out).not.toContain(value);
    expect(out).toContain("line1");
  });

  it.each([
    [{ vpa: "jane@okaxis" }, "okaxis"],
    [{ note: "pay jane@ybl" }, "jane@ybl"],
    [{ client_ip: "2001:db8::1" }, "2001:db8"],
    [{ seen_from: "2001:0db8:85a3:0000:0000:8a2e:0370:7334" }, "8a2e"],
    [{ lat: 51.52 }, "51.52"],
    [{ gstin: "27AAPFU0939F1ZV" }, "27AAPFU0939F1ZV"],
    [{ key_hint: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" }, "sk-proj"],
    [{ token_hint: "ya29.a0AfH6SMBabcdefghijklmnop" }, "ya29"],
  ])("removes Indian and modern identifiers: %j", (body, secret) => {
    expect(survives(jsonBody(body))).not.toContain(secret);
  });

  it("keeps clock times, which look like IPv6 groups", () => {
    expect(survives(jsonBody({ at: "12:30:45" }))).toContain("12:30:45");
  });

  it("redacts a link token in the path", () => {
    const out = survives({
      method: "GET",
      url: "https://app.test/invite/Abc123def456Ghi789jk/accept",
    });
    expect(out).not.toContain("Abc123def456Ghi789jk");
  });
});
