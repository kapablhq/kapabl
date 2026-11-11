# The Kapabl CLI

Not a developer? You don't need this page: [get the free audit](https://kapabl.dev/audit) instead.

The Kapabl CLI compiles your API into reviewed assistant tools. It's open source (Apache-2.0) and needs Node 24 or later.

Source: [github.com/kapablhq/kapabl](https://github.com/kapablhq/kapabl). The CLI is being published to npm; until it is, run it from a clone of that repository:

```bash
git clone https://github.com/kapablhq/kapabl.git
cd kapabl
corepack enable
pnpm install
alias kapabl="node $PWD/packages/cli/bin/kapabl.ts"
```

## Start with the audit

One command, one HTML report, nothing else written. [What the reports show](https://kapabl.dev/audit)

```bash
# a website: how AI assistants see it, beside sites of its kind
kapabl audit --site https://example.com --category personal
# a web app: every action an assistant could take, from your OpenAPI file
kapabl audit --openapi openapi.yaml
```

## The workflow

```bash
# or --har capture.har
kapabl compile --openapi openapi.yaml --tenant acme
# approve each action; writes kapabl/capabilities.lock.json
kapabl review
# contract tests against your API (reads by default)
kapabl test
kapabl emit --openapi out.json
```

Files are written to `./kapabl` (change it with `--dir`). Commit them.

| File | What it holds |
|---|---|
| `graph.json` | Every action found, with its inputs, outputs, side effect and where it came from |
| `capabilities.lock.json` | Your review decisions. Only approved actions are served. |
| `contracts.json` | Example arguments for contract tests. Never part of a tool's definition. |

## Commands

**`compile --openapi FILE` or `--har FILE`**: adds actions to the graph, pending review. OpenAPI 3.0 and 3.1 are accepted. A HAR file is scrubbed before anything reads it. `--tenant ID` is required the first time.

**`review`**: approve or reject pending actions (`--approve IDS`, `--approve-all`, `--reject IDS`, `--by NAME`). Correct a label with `--side-effect ID=read|write|destructive`, or set a per-call price with `--price ID=0.01USD`. A change to an approved action needs approving again.

**`example ID JSON`**: sets the arguments a contract test calls an action with.

**`test`**: runs a contract test for each approved action against your API, checking the status and the response schema. Reads run by default; writes only with `--include-writes`. Destructive actions never run from a test. A run in which nothing ran fails.

**`emit --openapi FILE`**: writes an OpenAPI 3.1 document of the approved actions.

**`audit --openapi FILE` or `--har FILE`**: writes a one-page action audit as HTML. It writes nothing else and uploads nothing. [About the audit](https://kapabl.dev/audit)

**`audit --site URL`**: writes a one-page website audit as HTML, for a site with no API. It sends the site's address, and nothing else, to Cloudflare's public scanner. `--category NAME` picks the kind of site to compare with, such as `personal`, `business`, `shop` or `technology`; `kapabl help` lists them all.

## How actions are labeled

- `GET` requests start as **read**.
- Everything else starts as **write** until you review it.
- Actions that delete, cancel, refund, pay or transfer start as **destructive**: they become their own tools and always need the user's confirmation.

Every inferred action also carries where it came from and a confidence score, so you can see what to check first.

[How setup works](https://kapabl.dev/setup) · [Security](https://kapabl.dev/security)
