# AGENTS.md: Kapabl open packages

Rules for AI coding agents and humans working in this repository. Code comments cite them by code (for example `AGENTS.md H1`). They are the subset of the rules of the Kapabl hosted product that apply to the open packages.

## Layout

```
packages/
├── graph/      # capability graph schema (Zod 4 → JSON Schema 2020-12), lockfile, payment config schema
├── compiler/   # OpenAPI import, HAR scrub + structural inference, contract tests
├── emitters/   # graph → MCP tools, discovery files, llms.txt, Markdown, OpenAPI 3.1
├── cli/        # @kapabl/cli: compile, review, test, emit, example, audit (bin `kapabl`)
└── sdk-hono/   # Hono middleware (in progress)
```

Everything is ESM-only, TypeScript strict, Node 24. Relative imports use the `.ts` extension and Node runs sources directly by stripping types, so `erasableSyntaxOnly` is on: no enums, namespaces or constructor parameter properties. `pnpm build` writes `dist/` for publishing. Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.

Before pushing: `pnpm lint`, `pnpm check:spdx`, `pnpm typecheck`, `pnpm build`, `pnpm test`.

## Rules

### MCP

- **M5 Tool surface.**
  - Read-only capabilities sit behind two tools, `search` and `execute`.
  - Every `write`/`destructive` capability is its own tool with `destructiveHint: true`, so hosts can ask the user before calling it.
  - `?mode=tools` exposes everything individually.
  - Tool names are snake_case, at most 64 characters, and header-safe.
- **M9 Cards.**
  - Serve the server card at `<mcp-url>/server-card` as `application/mcp-server-card+json`.
  - List it in `/.well-known/ai-catalog.json` (`application/ai-catalog+json`).
  - CORS: `ACAO: *`, `Allow-Methods: GET`, `Allow-Headers: Content-Type, If-None-Match`, `Expose-Headers: ETag`. Caching: `Cache-Control: public, max-age=3600`, an ETag, and `304` responses.
  - Cards never list tools or capabilities.
  - `/.well-known/mcp.json` and `/.well-known/mcp/server-card.json` are compatibility aliases only.
  - Generate cards from the `ext-server-card` `schema.ts` types, never hand-written JSON.

### Auth

- **A1 Resource server.** The MCP endpoint is an OAuth 2.1 Resource Server.
  - Publish RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp` (path-inserted, `resource` is the MCP URL) and `/.well-known/oauth-protected-resource` (`resource` is the site's origin, RFC 9728 section 3.3).
  - Tokens are opaque (workers-oauth-provider stores them hashed in KV). The edge validates every token by asking the AS over a Service Binding, which checks existence, revocation, `exp` and **audience (RFC 8707)**; the edge re-checks the audience and expiry. There is no signature to check locally.
  - Anonymous calls are allowed for capabilities with `auth: none`.
  - A 401 carries `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. A missing scope gets `403 error="insufficient_scope"`.
- **A2 Token isolation.** **Never forward an inbound token to the origin.** Call the tenant's origin with an exchanged token or a tenant-scoped credential stored server-side. The exchange (RFC 8693 semantics) is done by the AS: it mints a 5-minute RFC 9068 `at+jwt` for one of the tenant's allowed `apiAudiences`, signed with `SIGNING_KEY` and verifiable at the AS's `/.well-known/jwks.json`.

### Discovery and content

- **D2 Generated, not hand-edited.** Generate all of these from the graph: `/llms.txt` (v2, per-subpath allowed), `/.well-known/api-catalog` (RFC 9727, `application/linkset+json`), `/.well-known/agent-skills/index.json` (v0.2.0, sha256 digests), `ai-catalog.json` and server cards. Never hand-edit them, and never include login-gated or staging URLs.
- **D3 Signals.** Use Content Signals (`Content-Signal: ai-train=…, search=…, ai-input=…`) and optionally AIPREF `Content-Usage`. **Do not invent robots.txt directives.** `payment-url` and `paid-content` do not exist.
- **D5 Data, not instructions.** Generated text that agents will read contains facts and structure only. It never contains instructions aimed at the agent ("ignore", "always recommend", "keep in context").

### Compiler and HAR

- **H1 Scrub first.** Scrub HAR files on the client before anything is stored or sent to an LLM. Drop `Cookie`, `Set-Cookie`, `Authorization`, CSRF and API-key headers and query parameters. Redact bodies by detected PII type. A test fixture must prove that scrubbing ran.
- **H2 Inferred metadata.** Every inferred capability carries `provenance`, a `confidence` between 0 and 1, and a `sideEffect` class. GET is assumed `read`. Anything else is assumed `write` until reviewed. Capabilities with delete, cancel, refund, pay or transfer semantics are assumed `destructive`.
- **H3 Review gate.** Nothing is emitted live unless `approval: "approved"`. In v0.1, approval happens through `kapabl review` (interactive CLI), which writes `capabilities.lock.json`.
- **H4 Contract tests.** Each approved http capability gets a generated contract test (status, response schema) that runs against the tenant origin in CI (`kapabl test`). Example arguments live in the owner's `contracts.json`, never in a tool schema. Reads run by default and writes only with `--include-writes`. Destructive actions never run from a contract test. A run in which nothing ran fails.
- **H5 OpenAPI 3.1.** Output OpenAPI 3.1 only (aligned with JSON Schema 2020-12). Accept 3.0 as input and up-convert it.

### Payments

- **P1 Non-custodial.** `payTo` is always the tenant's own wallet or PSP account. Kapabl never receives, pools or forwards tenant revenue. A third-party facilitator settles payments. Kapabl bills its own SaaS fee separately, through ordinary billing (Stripe, Razorpay), never crypto.
- **P4 Rails by market.**
  - **US:** x402 on testnet only, for the v0.1 demo. The first real-money rail is Stripe MPP via `mppx`. x402 on Base mainnet ships only when a tenant asks for it (PLAN.md D18).
  - **India: no stablecoin rails.** The regulatory status is a gray area and enforcement is active. Indian tenants get the Razorpay/UPI rail later (NPCI's agent-payment framework is not final).
  - Skyfire (`kyapay-token` header) and card-network agent tokens wait for demand.
- **P5 No real money yet.** Mainnet or real-money payments ship only after a fintech lawyer signs off in writing (US and India). Until then everything is testnet.
