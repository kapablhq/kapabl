// SPDX-License-Identifier: Apache-2.0
// HAR scrubbing (AGENTS.md H1). Runs on the owner's machine before a capture is stored,
// inferred from, or shown to anything else. Credentials are dropped outright: Cookie,
// Set-Cookie, Authorization, CSRF and API-key headers and query parameters. Only headers
// that cannot carry a credential, a URL or a client's identity are kept. Bodies are
// parsed and redacted field by field; a body that cannot be parsed is dropped, because no
// pattern can be trusted to find every secret in free text. The report counts what was
// removed and records which requests carried credentials, so the compiler can infer that
// an action needs a signed-in user without keeping the credential.

import type { Entry, Har, Header, Param, PostData } from "har-format";

export type PiiKind =
  | "email"
  | "jwt"
  | "secret"
  | "card"
  | "ssn"
  | "aadhaar"
  | "pan"
  | "phone"
  | "ip"
  | "upi"
  | "sensitive-field"
  | "personal-field";

export interface ScrubReport {
  entries: number;
  /** Entries left out entirely: not an http(s) request, or not a HAR entry at all. */
  entriesDropped: number;
  headersDropped: number;
  queryParamsDropped: number;
  cookiesDropped: number;
  bodiesDropped: number;
  redactions: Partial<Record<PiiKind, number>>;
  /** Indexes (into the scrubbed entries) of requests that carried a credential before scrubbing. */
  credentialed: number[];
}

/** Headers kept, lowercase. Everything else is dropped: the compiler needs none of it. */
const KEPT_HEADERS = new Set(["accept", "content-type"]);

/** Header names that are credentials whatever their words say, lowercase. */
const CREDENTIAL_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-auth-key",
  "x-access-token",
  "x-csrf-token",
  "x-csrftoken",
  "x-xsrf-token",
  "csrf-token",
  "x-amz-security-token",
  "ocp-apim-subscription-key",
  "x-goog-api-key",
  "x-functions-key",
]);

/** Words that mark a name as holding a secret wherever they appear (`authToken`, `x-api-key`). */
const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "passcode",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "csrf",
  "xsrf",
  "cookie",
  "signature",
  "otp",
  "totp",
  "cvv",
  "cvv2",
  "cvc",
  "cvc2",
  "mpin",
  "tpin",
  "upipin",
  "credential",
  "jwt",
  "bearer",
  "aadhaar",
  "ssn",
  "accesskey",
  "authkey",
  "appkey",
  "privatekey",
  "secretkey",
  "signingkey",
  "cardnumber",
  "sessionid",
  "jsessionid",
  "phpsessid",
  "sessid",
  "salt",
  "mnemonic",
]);
/** Single words that end in a secret: `authtoken`, `apisecret`, `newpassword`. */
const SECRET_SUFFIX = /(?:token|secret|password|passwd|passphrase|passcode)$/;
/** Names that are secrets only on their own (`session` but not `session_count`). */
const SECRET_NAMES = new Set([
  "access",
  "refresh",
  "pw",
  "sess",
  "code",
  "ticket",
  "nonce",
  "hmac",
  "assertion",
  "samlresponse",
  "verifier",
  "authheader",
  "auth",
  "authorization",
  "session",
  "sid",
  "sig",
  "pin",
  "pan",
  "pass",
  "key",
]);
/** Two-word secrets (`api_key`, `cardNumber`, `session_id`, `upi_pin`). */
const SECRET_PAIRS = new Set([
  "api key",
  "access key",
  "auth key",
  "app key",
  "client key",
  "private key",
  "secret key",
  "signing key",
  "encryption key",
  "master key",
  "license key",
  "subscription key",
  "card number",
  "security code",
  "verification code",
  "recovery code",
  "backup code",
  "reset code",
  "reset key",
  "oob code",
  "login code",
  "invite code",
  "invitation code",
  "magic code",
  "activation key",
  "confirmation key",
  "access code",
  "mfa code",
  "session id",
  "auth code",
  "auth header",
  "authorization header",
  "client assertion",
  "code verifier",
  "upi pin",
  "atm pin",
  "card pin",
  "login pin",
  "security pin",
  "transaction pin",
  "seed phrase",
  "recovery phrase",
  "security answer",
  "secret answer",
  "user pass",
  "social security",
  "security number",
]);

/** Names that are secrets to scrub but ordinary inputs to ask an agent for. */
const ORDINARY_ALONE = new Set([
  "ticket",
  "key",
  "code",
  "access",
  "nonce",
  "signature",
  "refresh",
  "sig",
]);
/** `page_token`, `nextPageToken`, `continuation_token`: pagination cursors. */
const CURSOR_WORDS = new Set(["page", "next", "continuation", "sync", "cursor", "resume"]);

/** Last words that describe a secret rather than hold one. */
const DESCRIPTOR = new Set([
  "type",
  "kind",
  "format",
  "method",
  "mode",
  "algorithm",
  "required",
  "enabled",
  "count",
  "length",
  "status",
  "version",
  "expiry",
  "expires",
  "ttl",
]);
/** Last words that make a name a secret: `smtp_pass`, `redis_auth`, `GITHUB_PAT`. */
const SECRET_LAST = new Set(["pass", "pwd", "auth", "pat", "private", "sk", "session", "sid"]);

/**
 * Words before `code` or `key` that make it a public value (`country_code`,
 * `idempotency_key`). Any other `<word>_code` or `<word>_key` is treated as a secret:
 * `sms_code`, `device_code`, `merchant_key`, `STRIPE_KEY`.
 */
const PUBLIC_QUALIFIERS = new Set([
  "country",
  "postal",
  "post",
  "zip",
  "area",
  "dial",
  "region",
  "state",
  "city",
  "airport",
  "iata",
  "currency",
  "language",
  "lang",
  "locale",
  "status",
  "error",
  "response",
  "reason",
  "event",
  "type",
  "product",
  "item",
  "sku",
  "hs",
  "tax",
  "promo",
  "promotion",
  "discount",
  "coupon",
  "voucher",
  "color",
  "colour",
  "short",
  "public",
  "publishable",
  "primary",
  "foreign",
  "sort",
  "partition",
  "cache",
  "idempotency",
  "dedup",
  "dedupe",
  "lookup",
  "object",
  "group",
  "bar",
  "qr",
  "branch",
  "bank",
  "swift",
  "pin",
]);

/**
 * `X-Auth-Token` → [auth, token]; `cardNumber` → [card, number]; `X-CSRFToken` → [csrf,
 * token]. A leading `x` is dropped.
 */
function words(name: string): string[] {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // `CSRFToken` → `CSRF Token`, linear on long runs of capitals.
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts[0] === "x" && parts.length > 1 ? parts.slice(1) : parts;
}

/** `tokens` → `token`, so a list of secrets is a secret too. */
function singularWord(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * Whether a header, query parameter, JSON key or form field name holds a secret. Matches
 * whole words, so `author`, `passengers` and `footprint` are not secrets but `authToken`,
 * `x-api-key` and `session_id` are.
 */
export function isSensitiveName(name: string): boolean {
  if (isCredentialName(name)) return true;
  // Broader than a credential: scrubbing too much costs a sample value, too little a leak.
  const w = words(name);
  if (SECRET_NAMES.has(w.join(""))) return true;
  for (const word of w) {
    const one = singularWord(word);
    if (SECRET_WORDS.has(one) || SECRET_SUFFIX.test(one)) return true;
  }
  const last = w.at(-1) as string;
  if (w.length >= 2 && SECRET_LAST.has(last)) return true;
  if (w.length >= 2 && (last === "code" || last === "key")) {
    if (!PUBLIC_QUALIFIERS.has(w.at(-2) as string)) return true;
  }
  return false;
}

/**
 * Whether a name is a credential an agent must never be asked for (`api_key`,
 * `password`, `session_id`): narrower than `isSensitiveName`, so `max_tokens`,
 * `projectKey` and `plan_code` stay inputs.
 */
export function isCredentialName(name: string): boolean {
  const w = words(name);
  // Alone, these are ordinary fields (`{"ticket": …}`, `?code=SAVE10`, `key`/`value`).
  if (w.length === 1 && ORDINARY_ALONE.has(w[0] as string)) return false;
  // A page token is a cursor, not a credential.
  if (w.at(-1) === "token" && w.length >= 2 && CURSOR_WORDS.has(w.at(-2) as string)) return false;
  // Something about a secret is not the secret: `signature_type`, `token_count`.
  if (w.length >= 2 && DESCRIPTOR.has(w.at(-1) as string)) return false;
  for (const word of w) {
    if (SECRET_WORDS.has(word) || SECRET_SUFFIX.test(word)) return true;
  }
  if (SECRET_NAMES.has(w.join(""))) return true;
  for (let i = 0; i + 1 < w.length; i++) {
    if (SECRET_PAIRS.has(`${w[i]} ${singularWord(w[i + 1] as string)}`)) return true;
  }
  return false;
}

/** Keys and fields that hold personal data whatever their value looks like. */
const PERSONAL_FIELD =
  /address|street|post(?:al)?[-_]?code|^zip|pin[-_]?code|birth|^dob$|passport|account[-_]?number|^iban$|national[-_]?id|phone|mobile|msisdn|e[-_]?mail|^(?:vpa|upi(?:[-_]?id)?|lat|lng|lon|latitude|longitude|geo(?:location)?|location|coordinates|gstin|tax[-_]?id|ifsc|routing[-_]?number|sort[-_]?code|licen[cs]e[-_]?(?:number|no)?)$/i;
/** One-word names: `surname`, `firstname`, `username`. */
const NAME_WORD = /^(?:sur|nick|user|first|last|full|given|family|middle|maiden|display)name$/;
/** Words that make a `<word>_name` a person's name (`cardholder_name`, `billing_name`). */
const PERSON_WORDS = new Set([
  "first",
  "last",
  "full",
  "given",
  "family",
  "middle",
  "maiden",
  "nick",
  "display",
  "legal",
  "contact",
  "customer",
  "user",
  "person",
  "owner",
  "member",
  "billing",
  "shipping",
  "recipient",
  "sender",
  "payer",
  "payee",
  "holder",
  "cardholder",
  "beneficiary",
  "nominee",
  "guardian",
  "father",
  "mother",
  "spouse",
  "applicant",
  "employee",
  "patient",
  "student",
  "emergency",
  "account",
]);
/** A bare `name` is personal at the top level or under one of these keys (`customer.name`). */
const PERSON_PARENT =
  /customer|user|person|contact|owner|member|billing|shipping|recipient|sender|payer|payee|profile|employee|patient|student|holder|beneficiary/i;

/** Whether a key or field holds personal data no pattern can detect, such as a name. */
export function isPersonalName(name: string, parent?: string): boolean {
  if (PERSONAL_FIELD.test(name)) return true;
  const w = words(name);
  const last = w.at(-1) ?? "";
  if (NAME_WORD.test(last)) return true;
  if (last !== "name") return false;
  if (w.length === 1) return parent === undefined || PERSON_PARENT.test(parent);
  return w.slice(0, -1).some((word) => PERSON_WORDS.has(word));
}

/** Ordered: the more specific patterns run first. */
const PATTERNS: [PiiKind, RegExp][] = [
  [
    "secret",
    // To the END line, or to the end of the text when it was cut off.
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  ],
  // Incoming-webhook URLs are the credential: hooks.slack.com/services/T…/B…/<token>.
  ["secret", /\bT[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g],
  [
    "secret",
    /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{20,}|A(?:KIA|SIA)[0-9A-Z]{16}|shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|lin_api_[A-Za-z0-9]{20,}|dop_v1_[a-f0-9]{40,}|hf_[A-Za-z0-9]{30,}|SK[0-9a-fA-F]{32}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|whsec_[A-Za-z0-9+/=]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|ya29\.[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g,
  ],
  // A local part starts where the run of its characters does and is at most 64 long, so a
  // long string without an @ is scanned once, not once per position.
  // A credential in text: `Authorization: Bearer 9f8e…`. Checked in `text()`, so `token
  // validation` is left alone.
  ["secret", /(?<![A-Za-z0-9])(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi],
  // A local part starts where the run of its characters does, so a long string without an
  // @ is scanned once, not once per position. `%40` is an encoded @ (`?email=jane%40x.com`).
  ["email", /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi],
  // UPI handles have no dot after the @: `jane@okaxis`.
  ["upi", /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}\b/g],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["pan", /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  ["card", /\b(?:\d[ -]?){12,18}\d\b/g],
  ["aadhaar", /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g],
  [
    "ip",
    // IPv6 needs eight groups or a `::`, so clock times (12:30:45) are not addresses.
    /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:\b[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5}\b)?|\b(?:\d{1,3}\.){3}\d{1,3}\b/gi,
  ],
  [
    "phone",
    // E.164 (+14155550100); separated national and international forms (415 555 0100,
    // 98765 43210, +91-98765-43210); Indian mobiles (9876543210); NANP (4155550100).
    /\+[1-9]\d{7,14}\b|(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,5}[ .-]\d{3,5}(?:[ .-]\d{2,5})?\b|\b[6-9]\d{9}\b|\b[2-9]\d{2}[2-9]\d{6}\b/g,
  ],
];

/**
 * Any placeholder the scrubber writes: `[email]` inside text, `[personal]` for a whole
 * string, and `[redacted:integer]` where a value of another type was.
 */
export const PLACEHOLDER =
  /\[(?:redacted|personal|email|upi|jwt|secret|card|ssn|aadhaar|pan|phone|ip)(?::(?:integer|number|boolean|object|array))?\]/;
const TYPED_PLACEHOLDER = /^\[[a-z-]+:(integer|number|boolean|object|array)\]$/;

/** A whole value replaced by a placeholder that remembers its JSON type. */
function placeholder(kind: string, value: unknown): string {
  if (typeof value === "string") return `[${kind}]`;
  const type = Array.isArray(value)
    ? "array"
    : typeof value === "number"
      ? Number.isInteger(value)
        ? "integer"
        : "number"
      : typeof value;
  return `[${kind}:${type}]`;
}

/**
 * Put back the types of whole-value placeholders, so a schema inferred from scrubbed
 * samples keeps them (a redacted PIN is still an integer). The stand-ins carry no data.
 */
export function withTypes(value: unknown): unknown {
  if (typeof value === "string") {
    switch (TYPED_PLACEHOLDER.exec(value)?.[1]) {
      case "integer":
        return 0;
      case "number":
        return 0.5;
      case "boolean":
        return false;
      case "object":
        return {};
      case "array":
        return [];
      default:
        return value;
    }
  }
  if (Array.isArray(value)) return value.map(withTypes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withTypes(v)]));
  }
  return value;
}

/** Route names that read like secrets but name a route, not a value: `/auth/callback`. */
const ROUTE_WORDS = new Set(["auth", "authorization"]);
/** Routes whose next segment is often a bearer link token: `/invite/<token>/accept`. */
const LINK_ROUTES =
  /^(?:invites?|invitations?|reset|verify|verification|magic|confirm|confirmation|unsubscribe|share|shared|s|join|claim|activate|activation)$/i;
/** `/verify-email/<token>`, `/invites/accept/<token>`: a route word anywhere in the name. */
function linkRoute(segment: string): boolean {
  return words(segment.split(";")[0] ?? "").some((w) => LINK_ROUTES.test(w));
}
/** A long segment mixing letters and digits: a link token or opaque id. */
const OPAQUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{16,}$/;
/** A path- or protocol-relative URL with a query, at the start of text or after a delimiter. */
// Bounded runs keep a long string with no `?` from being rescanned at every start.
const RELATIVE_URL = /(^|[\s"'(=])((?:\/\/[^\s"'<>/?]{1,253})?\/[^\s"'<>?]{0,512}\?[^\s"'<>]+)/g;
/** A credential header written out in text; its whole value is the secret. */
const CREDENTIAL_HEADER =
  /\b((?:proxy-)?authorization|x-api-key|api-key|(?:set-)?cookie)(\s*:\s*)(?!\[)[^\r\n"']+/gi;
/** `curl -u user:password`. */
const CURL_USER = /(\s(?:-u|--user)\s+)(?!\[)\S+:\S+/g;
/** `name=value` or `name: value`, name and value single tokens. */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]{1,63})(["']?\s*[=:]\s*['"]?)(?!\[)(?:(?:bearer|basic|token)\s+)?[^\s'"&,;]+/gi;
/** The userinfo of a URL with any scheme. */
const USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s"'<>]+@/g;
/** A long query value that reads like a token: base64 or opaque, with a digit. */
const QUERY_TOKEN = /^(?=.*\d)[A-Za-z0-9_+/=.~-]{24,}$/;

/** `Bearer 9f8e7d…` or `Basic dXNlcjpwYXNz`, not `token validation`. */
function credential(match: string): boolean {
  const [keyword = "", value = ""] = match.split(/\s+/);
  if (/\d/.test(value)) return true;
  if (keyword.toLowerCase() !== "basic") return false;
  try {
    return atob(value).includes(":");
  } catch {
    return false;
  }
}

/** Absolute URLs inside text, whose query and userinfo can carry tokens. */
const EMBEDDED_URL = /https?:\/\/[^\s"'<>\\]+/gi;
/** The key naming a `{ name, value }` pair's value: `headers: [{ name, value }]`. */
const PAIR_NAME = [
  "name",
  "key",
  "field",
  "header",
  "param",
  "label",
  "title",
  "id",
  "type",
  "slug",
];
/** Input types whose value is a secret: `{ type: "password", value }`. */
const SECRET_INPUT = /^(?:password|secret|hidden)$/i;

/** JSON hijacking guards some APIs put before a JSON body. */
const XSSI_PREFIX = /^\s*(?:\)\]\}'?,?|while\s*\(1\);|for\s*\(;;\);|\{\}&&)\s*/;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isEntry(value: unknown): value is Entry {
  const request = (value as { request?: { url?: unknown; method?: unknown } } | null)?.request;
  return (
    typeof request?.url === "string" &&
    typeof request.method === "string" &&
    /^https?:\/\//i.test(request.url) &&
    URL.canParse(request.url)
  );
}

class Scrubber {
  /** Set while a relative URL found in text is being scrubbed. */
  private inRelativeUrl = false;
  readonly report: ScrubReport = {
    entries: 0,
    entriesDropped: 0,
    headersDropped: 0,
    queryParamsDropped: 0,
    cookiesDropped: 0,
    bodiesDropped: 0,
    redactions: {},
    credentialed: [],
  };

  private count(kind: PiiKind, n = 1) {
    this.report.redactions[kind] = (this.report.redactions[kind] ?? 0) + n;
  }

  /** Replace detected PII in free text. Text that is itself JSON is redacted as JSON. */
  text(value: string): string {
    if (/^\s*[{[]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed !== null && typeof parsed === "object") return JSON.stringify(this.json(parsed));
      } catch {
        // Not JSON after all.
      }
    }
    let out = value.replace(EMBEDDED_URL, (match) => this.embeddedUrl(match));
    // Relative links carry queries too: `/invitations/accept?token=…`, `//host/?token=…`.
    // Not again inside one: a query value holding `/?` would recurse without end.
    if (!this.inRelativeUrl && out.includes("?")) {
      out = out.replace(RELATIVE_URL, (match, lead: string, url: string) => {
        const base = "https://relative.invalid";
        if (!URL.canParse(url, base)) return match;
        const original = new URL(url, base);
        this.inRelativeUrl = true;
        let scrubbed: URL;
        try {
          scrubbed = new URL(this.url(original.toString()).url);
        } finally {
          this.inRelativeUrl = false;
        }
        // Left as written when nothing was taken out.
        if (
          scrubbed.pathname === original.pathname &&
          scrubbed.searchParams.toString() === original.searchParams.toString()
        )
          return match;
        const kept = url.startsWith("//")
          ? `//${scrubbed.host}${scrubbed.pathname}${scrubbed.search}`
          : `${scrubbed.pathname}${scrubbed.search}`;
        return `${lead}${kept}`;
      });
    }
    // Userinfo in any URL, not only http: `postgres://admin:pw@db/app`.
    out = out.replace(USERINFO, (_, scheme: string) => {
      this.count("secret");
      return `${scheme}[secret]@`;
    });
    for (const [kind, pattern] of PATTERNS) {
      out = out.replace(pattern, (match) => {
        if (kind === "secret" && /^(?:bearer|basic|token)\s/i.test(match) && !credential(match))
          return match;
        if (kind === "card") {
          const digits = match.replace(/\D/g, "");
          if (digits.length < 13 || !luhn(digits)) return match;
        }
        this.count(kind);
        return `[${kind}]`;
      });
    }
    // `password=hunter2`, `API_KEY: abcd…` in config blobs, logs and curl lines. After the
    // patterns, so `Authorization: Bearer …` is already `[secret]`.
    out = out.replace(CREDENTIAL_HEADER, (_, name: string, sep: string) => {
      this.count("sensitive-field");
      return `${name}${sep}[redacted]`;
    });
    out = out.replace(CURL_USER, (_, flag: string) => {
      this.count("secret");
      return `${flag}[redacted]`;
    });
    out = out.replace(ASSIGNMENT, (match, name: string, sep: string) => {
      if (!isSensitiveName(name)) return match;
      this.count("sensitive-field");
      return `${name}${sep}[redacted]`;
    });
    return out;
  }

  /** A URL inside a value, scrubbed like a request URL; left as written when nothing changes. */
  embeddedUrl(match: string): string {
    if (!URL.canParse(match)) return match;
    const original = new URL(match);
    const scrubbed = this.url(match).url;
    const untouched =
      original.search === "" &&
      original.hash === "" &&
      !original.username &&
      !original.password &&
      new URL(scrubbed).pathname === original.pathname;
    return untouched ? match : scrubbed;
  }

  /** An integer can be a phone or card number too; it keeps its type when redacted. */
  number(value: number): unknown {
    if (!Number.isInteger(value)) return value;
    const digits = String(value);
    const scrubbed = this.text(digits);
    if (scrubbed === digits) return value;
    return placeholder(/\[([a-z-]+)\]/.exec(scrubbed)?.[1] ?? "redacted", value);
  }

  /**
   * Redact a parsed JSON value. A sensitive key loses its whole value, whatever its type;
   * a personal key loses its scalar value; keys and strings lose detected PII.
   */
  json(value: unknown, key?: string, parent?: string): unknown {
    if (key !== undefined && value !== null) {
      if (isSensitiveName(key)) {
        this.count("sensitive-field");
        return placeholder("redacted", value);
      }
      if ((typeof value === "string" || typeof value === "number") && isPersonalName(key, parent)) {
        this.count("personal-field");
        return placeholder("personal", value);
      }
    }
    if (typeof value === "string") return this.text(value);
    if (typeof value === "number") return this.number(value);
    // Array items inherit the array's key as their parent: `customers: [{ name }]`.
    // Everything inside a personal object is personal: `address: { line1 }`, `name: { first }`.
    if (
      key !== undefined &&
      value !== null &&
      typeof value === "object" &&
      isPersonalName(key, parent)
    )
      return this.personal(value);
    if (Array.isArray(value)) return value.map((v) => this.json(v, undefined, key ?? parent));
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      // `{ name: "Authorization", value: "..." }`: the value is judged by its sibling name.
      // Of several (`{ name: "Prod hook", header: "Authorization", value }`), the most
      // sensitive one decides.
      const labels = PAIR_NAME.map((k) => record[k]).filter(
        (v): v is string => typeof v === "string",
      );
      const label =
        labels.find((l) => isSensitiveName(l) || SECRET_INPUT.test(l)) ??
        labels.find((l) => isPersonalName(l)) ??
        labels[0];
      const paired = label !== undefined && "value" in record;
      return Object.fromEntries(
        Object.entries(record).map(([k, v]) => {
          if (paired && k === "value") {
            const name = SECRET_INPUT.test(label) ? "password" : label;
            return [this.text(k), this.json(v, name, key ?? parent)];
          }
          return [this.text(k), this.json(v, k, key ?? parent)];
        }),
      );
    }
    return value;
  }

  /** Every scalar inside a personal value, replaced; keys are kept (scrubbed). */
  personal(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.personal(v));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [this.text(k), this.personal(v)]),
      );
    }
    if (value === null) return value;
    this.count("personal-field");
    return placeholder("personal", value);
  }

  /** JSON, JSON behind an XSSI guard, or newline-delimited JSON; undefined if none of these. */
  jsonBody(text: string, declared: boolean): string | undefined {
    const body = text.replace(XSSI_PREFIX, "");
    if (declared || /^\s*[{[]/.test(body)) {
      try {
        return JSON.stringify(this.json(JSON.parse(body)));
      } catch {
        // Not one JSON value; maybe one per line.
      }
    }
    const lines = body.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length < 2) return undefined;
    let values: unknown[];
    try {
      values = lines.map((line) => JSON.parse(line));
    } catch {
      return undefined;
    }
    return values.map((v) => JSON.stringify(this.json(v))).join("\n");
  }

  /** A body redacted field by field, or undefined when its encoding is not one we can parse. */
  body(text: string, mimeType: string | undefined): string | undefined {
    const type = (mimeType ?? "").toLowerCase();
    const json = this.jsonBody(text, /\bjson\b/.test(type));
    if (json !== undefined) return json;
    if (type.includes("x-www-form-urlencoded")) {
      const out = new URLSearchParams();
      for (const [k, v] of new URLSearchParams(text)) out.append(this.text(k), this.param(k, v));
      return out.toString();
    }
    return undefined;
  }

  /** A query, form or matrix parameter's value. */
  param(name: string, value: string): string {
    if (isSensitiveName(name)) {
      this.count("sensitive-field");
      return "[redacted]";
    }
    if (isPersonalName(name)) {
      this.count("personal-field");
      return "[personal]";
    }
    return this.text(value);
  }

  headers(headers: unknown): { kept: Header[]; credentialed: boolean } {
    let credentialed = false;
    const kept: Header[] = [];
    for (const header of list<Header>(headers)) {
      if (typeof header?.name !== "string" || typeof header.value !== "string") {
        this.report.headersDropped++;
        continue;
      }
      const name = header.name.toLowerCase();
      // Words are read from the name as written: `X-CSRFToken` is [csrf, token].
      if ((CREDENTIAL_HEADERS.has(name) || isSensitiveName(header.name)) && name !== "set-cookie") {
        credentialed = true;
      }
      if (!KEPT_HEADERS.has(name)) {
        this.report.headersDropped++;
        continue;
      }
      kept.push({ name: header.name, value: this.text(header.value) });
    }
    return { kept, credentialed };
  }

  /**
   * One path segment. PII or a secret replaces the whole segment with a placeholder (the
   * compiler templates it like an id), as does anything after a segment named like a
   * secret (`/token/<value>`). Sensitive matrix parameters (`;jsessionid=`) are dropped.
   */
  segment(
    raw: string,
    previous: string | undefined,
    earlier?: string,
  ): { segment: string; credentialed: boolean } {
    let credentialed = false;
    const [head = "", ...matrix] = raw.split(";");
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    let segment = head;
    const before = previous === undefined ? "" : decode(previous.split(";")[0] ?? "");
    if (head !== "") {
      const decoded = decode(head);
      if (
        (before !== "" && !ROUTE_WORDS.has(before.toLowerCase()) && isSensitiveName(before)) ||
        (OPAQUE.test(decoded) &&
          (linkRoute(before) || linkRoute(decode(earlier ?? "")) || decoded.length >= 32))
      ) {
        this.count("sensitive-field");
        segment = "[redacted]";
      } else {
        const scrubbed = this.text(decoded);
        if (scrubbed !== decoded) segment = PLACEHOLDER.exec(scrubbed)?.[0] ?? "[redacted]";
      }
    }
    for (const param of matrix) {
      const at = param.indexOf("=");
      const name = decode(at < 0 ? param : param.slice(0, at));
      if (isSensitiveName(name)) {
        this.report.queryParamsDropped++;
        credentialed = true;
        continue;
      }
      if (at < 0) {
        segment += `;${param}`;
        continue;
      }
      const value = decode(param.slice(at + 1));
      const scrubbed = this.param(name, value);
      segment += `;${encodeURIComponent(this.text(name))}=${scrubbed === value ? param.slice(at + 1) : scrubbed}`;
    }
    return { segment, credentialed };
  }

  /** Scrubs the path, drops sensitive query parameters, and removes userinfo and fragment. */
  url(rawUrl: string): { url: string; credentialed: boolean } {
    let credentialed = false;
    const url = new URL(rawUrl);
    const raw = url.pathname.split("/");
    url.pathname = raw
      .map((segment, i) => {
        const out = this.segment(
          segment,
          i > 1 ? raw[i - 1] : undefined,
          i > 2 ? raw[i - 2] : undefined,
        );
        credentialed ||= out.credentialed;
        return out.segment;
      })
      .join("/");
    const kept = new URLSearchParams();
    for (const [name, value] of url.searchParams) {
      if (isSensitiveName(name)) {
        this.report.queryParamsDropped++;
        credentialed = true;
        continue;
      }
      // A long opaque value, or one under a one- or two-letter name (`?t=`), is a link token.
      if (QUERY_TOKEN.test(value) || (OPAQUE.test(value) && name.length <= 2)) {
        this.count("sensitive-field");
        kept.append(this.text(name), "[redacted]");
        continue;
      }
      kept.append(this.text(name), this.param(name, value));
    }
    url.search = kept.toString();
    url.hash = "";
    url.username = "";
    url.password = "";
    return { url: url.toString(), credentialed };
  }

  entry(entry: Entry, index: number): Entry {
    this.report.entries++;
    const request = entry.request;
    const response = entry.response;
    const reqHeaders = this.headers(request.headers);
    const url = this.url(request.url);
    const cookies = list(request.cookies).length;
    this.report.cookiesDropped += cookies + list(response?.cookies).length;
    if (reqHeaders.credentialed || url.credentialed || cookies > 0) {
      this.report.credentialed.push(index);
    }

    let postData: PostData | undefined;
    if (request.postData) {
      const source = request.postData;
      let text: string | undefined;
      if (typeof source.text === "string") {
        text = this.body(source.text, source.mimeType);
        if (text === undefined) {
          // Kept as a marker so the compiler still sees that there was a body it cannot use.
          this.report.bodiesDropped++;
          text = "[dropped]";
        }
      }
      const params = list<Param>(source.params)
        .filter((p) => typeof p?.name === "string")
        .map((p) => ({
          name: this.text(p.name),
          // A file part's value is the file: never kept.
          ...(typeof p.value === "string" && p.fileName === undefined
            ? { value: this.param(p.name, p.value) }
            : {}),
        }));
      postData = {
        mimeType: typeof source.mimeType === "string" ? source.mimeType : "",
        ...(text !== undefined ? { text } : {}),
        ...(params.length > 0 ? { params } : {}),
      } as unknown as PostData;
    }

    const content = response?.content ?? { size: 0, mimeType: "" };
    let contentText: string | undefined;
    if (typeof content.text === "string" && content.text !== "") {
      contentText =
        content.encoding === "base64" ? undefined : this.body(content.text, content.mimeType);
      if (contentText === undefined) this.report.bodiesDropped++;
    }

    const scrubbedUrl = new URL(url.url);
    // Only fields the compiler needs. Timings, IPs, initiators and page titles are dropped.
    return {
      startedDateTime: typeof entry.startedDateTime === "string" ? entry.startedDateTime : "",
      time: 0,
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      request: {
        method: request.method,
        url: url.url,
        httpVersion: typeof request.httpVersion === "string" ? request.httpVersion : "HTTP/1.1",
        headers: reqHeaders.kept,
        // Rebuilt from the scrubbed URL, so the two can never disagree.
        queryString: [...scrubbedUrl.searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
        ...(postData ? { postData } : {}),
      },
      response: {
        status: typeof response?.status === "number" ? response.status : 0,
        statusText: "",
        httpVersion: typeof response?.httpVersion === "string" ? response.httpVersion : "HTTP/1.1",
        headers: this.headers(response?.headers).kept,
        cookies: [],
        content: {
          // Whether there was a body survives even when the body does not.
          size: Math.max(
            typeof content.size === "number" ? content.size : 0,
            typeof content.text === "string" ? content.text.length : 0,
          ),
          mimeType: typeof content.mimeType === "string" ? content.mimeType : "",
          ...(contentText !== undefined ? { text: contentText } : {}),
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
    };
  }
}

/** Scrub a parsed HAR. The input is not modified. Throws if it is not a HAR. */
export function scrubHar(input: unknown): { har: Har; report: ScrubReport } {
  const log = (input as { log?: { entries?: unknown } } | null)?.log;
  if (!log || !Array.isArray(log.entries)) throw new Error("not a HAR file: missing log.entries");
  const scrubber = new Scrubber();
  const usable = (log.entries as unknown[]).filter(isEntry);
  scrubber.report.entriesDropped = log.entries.length - usable.length;
  const entries = usable.map((e, i) => scrubber.entry(e, i));
  return {
    har: { log: { version: "1.2", creator: { name: "kapabl-scrub", version: "1" }, entries } },
    report: scrubber.report,
  };
}
