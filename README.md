# Kapabl open packages

Turn a web app's API into reviewed, typed tools for AI agents. These packages compile an
OpenAPI document or a browser capture (HAR) into a **capability graph**, let the owner review
every action, and generate the agent-facing files from it: MCP tool definitions, discovery
files, `llms.txt`, Markdown and OpenAPI 3.1.

The hosted runtime that serves those tools (MCP endpoint, sign-in, payments) is
[Kapabl](https://kapabl.dev). Everything here runs on your machine.

## Try it: the action audit

```bash
npx @kapabl/cli audit --openapi openapi.yaml
```

This writes `audit.html`: every action found, grouped into reads, writes and destructive
actions, who can call each one, which credential reaches your API, and what was left out and
why. A HAR capture works too (`--har capture.har`); it is scrubbed of cookies, tokens and
personal data before anything reads it. Nothing is uploaded.

## The workflow

```bash
npx @kapabl/cli compile --openapi openapi.yaml --tenant acme   # or --har capture.har
npx @kapabl/cli review          # approve each action; writes kapabl/capabilities.lock.json
npx @kapabl/cli test            # contract tests against your API (reads by default)
npx @kapabl/cli emit --openapi out.json
```

Nothing is emitted until it is approved, and a change to an approved action needs approving
again.

## Packages

| Package | What it does |
|---|---|
| `@kapabl/graph` | Capability graph schema (Zod 4 → JSON Schema 2020-12) and lockfile |
| `@kapabl/compiler` | OpenAPI 3.0/3.1 import, HAR scrubbing and inference, contract tests |
| `@kapabl/emitters` | Graph → MCP tools, discovery files, `llms.txt`, Markdown, OpenAPI 3.1 |
| `@kapabl/cli` | The `kapabl` command |
| `@kapabl/sdk-hono` | Hono middleware (in progress) |

## Development

Node 24 and pnpm (`corepack enable`), then:

```bash
pnpm install
pnpm lint && pnpm check:spdx && pnpm typecheck && pnpm build && pnpm test
```

The rules every change follows are in [AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE).
