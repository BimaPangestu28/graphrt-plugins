# Contributing to graphrt-plugins

Thanks for helping to grow the plugin catalog. This guide covers how to propose a plugin, what a plugin must
contain, the agent-safety rules reviewers enforce, and how a change gets from a pull request to a release.

Everything here describes what the repo already does. When this guide and the code disagree, the code
(`scripts/`, `shared/lib/`, the CI workflows) wins; please fix the guide in the same PR.

## Contents
- [Before you start](#before-you-start)
- [Choosing a plugin type](#choosing-a-plugin-type)
- [Repo mechanics](#repo-mechanics)
- [Agent-safety checklist](#agent-safety-checklist)
- [Tests](#tests)
- [What each plugin needs](#what-each-plugin-needs)
- [Commits and pull requests](#commits-and-pull-requests)
- [Review process](#review-process)
- [Releases](#releases)

## Before you start

### Check for duplicates
- Read the plugin table in the [README](README.md#plugins). If a plugin already covers the API, open an issue or a
  PR against it instead of adding a second one.
- Each top-level directory is one plugin and is installed on its own (`graphrt plugin install ./<plugin>`).

### Prefer official APIs
- Build on the provider's official, documented API with the credentials the provider intends you to use.
- Scraping, reverse-engineered clients and unofficial automation (WhatsApp Web, driving desktop apps, headless
  browsers on sites that forbid it) are accepted only as:
  - status `experimental`,
  - a `tos_risk` of `medium` or `high` with `tos_notes`,
  - a `> **Warning:**` blockquote at the top of the plugin README that names the official alternative, if any.
- Read the provider's terms before writing code. [docs/tos-audit.md](docs/tos-audit.md) shows how existing plugins
  were rated, with the clauses and mitigations; add an entry for your plugin when it is `medium` or `high`.

### Open an issue first for large plugins
Open an issue before you write anything big (more than about 15 operations, request signing, a native driver,
a browser, a plugin with a ToS risk). Say which API and version, which operations, the credential type, and which
operations you think should be node only. A short agreement up front saves a rewrite.

## Choosing a plugin type

| Type | Use it for | Start from |
|------|-----------|------------|
| **Declarative** (`defineRestPlugin`) | REST/JSON APIs with bearer, API-key or OAuth2 auth, pagination and jobs | [docs/declarative-plugins.md](docs/declarative-plugins.md) and the reference plugin [`open-meteo/`](open-meteo/) |
| **Hand-written** | Database drivers, local tools (files, ffmpeg, shell), SFTP, anything with logic the declarative layer cannot express | [`meta-api/`](meta-api/) (REST with many custom operations), [`postgres/`](postgres/) (driver with its own `package.json` and lockfile) |

- Default to declarative. The whole plugin is data in `definition.mjs`, and the layer gives you origin guards,
  redaction, safe retries, `api_request`, result truncation and load-time validation for free.
- If only one or two operations need custom code, append a hand-written operation to a declarative plugin (see
  "Escape hatches" in the guide) instead of rewriting the whole plugin by hand.
- Hand-written plugins still build on `shared/lib` (`api-client`, `params`, `operations`, `polling`, `path`,
  `public-https-fetch`, `testing`). Read the JSDoc there before writing your own HTTP or validation code.

## Repo mechanics

### Generated files: never edit by hand
Run `npm run sync` at the repo root after every change to a definition, to `shared/lib` or to
`plugin-status.json`. It regenerates:

- `<plugin>/lib/shared/`, a copy of `shared/lib` (each plugin is installed on its own, so each carries a copy),
- `<plugin>/graphrt-plugin.json`, built from `definition.mjs`,
- `<plugin>/OPERATIONS.md`,
- the status columns of the root README table and the `**Status:**` line of each plugin README.

`npm run check` (and `npm test`) fails when any of these is stale. Commit the regenerated files.
Do not edit `shared/` or `scripts/` in a plugin PR; if you need a change there, open a separate PR or issue.

### Protocol and credentials
- **stdout is the JSON-RPC protocol.** Never `console.log` in plugin code. Log to stderr.
- **Credentials come only from environment variables** (or, for per-user tokens, from graphrt's tool call context
  via `toolUserToken`; see [docs/declarative-plugins.md](docs/declarative-plugins.md#per-user-tool-tokens-toolusertoken)).
  Never accept a token, password or key as an operation
  argument, and never write one to a file, a log or a test.
- Credentials are redacted from errors, logs and `api_request` responses. Keep it that way. An endpoint that
  returns a credential on purpose (token exchange) is a hand-written `nodeOnly` operation.
- Ids that go into URL paths must pass through `pathSegment` (the declarative layer does it for you).
- Validate inputs from workflow templates (numbers, booleans and arrays arrive as strings; empty strings happen)
  and from LLM tool calls.

### Reserved parameter names
graphrt takes some config keys from every workflow node itself (`id`, `type`, `title`, `width`, `height`,
`timeout`, `retry`, ...; see `shared/lib/reserved-node-keys.mjs`). A parameter with such a name can never be set
from a node. Rename it and keep the API's field name with `wireName`.
`scripts/check-reserved-parameters.mjs` (part of `npm test`) fails on offenders.

### Dependencies and lockfiles
- API plugins have no npm dependencies.
- A plugin that needs packages (a driver, `sharp`, Playwright) declares them in its own `package.json` and
  commits its `package-lock.json`.
- `scripts/install-plugin-dependencies.sh` (used by CI) runs `npm ci` for every plugin with dependencies and
  fails if the lockfile is missing. Run it locally before `npm test` if your plugin has dependencies.
- Release tarballs include production dependencies, so add only what you need.

## Agent-safety checklist
This is mandatory. Every operation is both a workflow node and an agent (LLM) tool, and operations receive a
`source` (`"node"` or `"tool"`). A workflow author chose a node deliberately; an LLM can be talked into anything.
Reviewers walk this list for every PR, and the PR template repeats it. In the README, state the decision for each
operation that is node only or opt-in.

- [ ] **`nodeOnly` for the irreversible and the administrative.** Money movement (payments, captures, refunds,
  payouts), deletes, bulk destructive operations, mass sends and campaigns, account or permission admin, token
  refresh and anything that returns credentials. Tools never see these.
- [ ] **Opt-in env for sends, posts and writes from tools.** Messages, emails, SMS, chat posts, DMs, public
  posts and other writes need `toolPolicy: "optIn:<PLUGIN>_TOOL_ALLOW_<ACTION>"` (refused unless the env is `1`;
  nodes are unaffected). Hand-written plugins implement the same check on `source === "tool"`.
- [ ] **Recipient and target allowlists.** Sends to arbitrary recipients need an allowlist env (exact match,
  unset refuses everything) in addition to the opt-in. Writes that could move private data to a public or
  third-party place (public repos or channels, sharing, adding external users, extra folders) need a target
  allowlist as well.
- [ ] **Paid calls are `write: "unsafe"` and never retried.** Generation, chat, embeddings, transcription,
  translation, SMS/email sends and any billed request get a `checkHint` that says where to see whether it was
  billed. Never mark them `idempotent`: the shared client retries idempotent requests after a timeout, which is
  when the provider most likely already billed. Exceptions are free calls and APIs with idempotency keys
  (`idempotencyKeyHeader`). The README states the pricing.
- [ ] **No callback URLs on tools.** Webhook, callback and notify URL parameters let a provider push data to an
  arbitrary host. Offer them only on a `nodeOnly` `*_with_callback` variant.
- [ ] **`api_request` is GET-only for tools, with read-path allowlists.** If the API has secret-bearing GET
  endpoints (tokens, variables, keys, webhook configs), the custom guard must be an allowlist of safe read paths,
  not a denylist, and must normalise suffixes such as `.json` before matching. Set `apiRequest: false` when in
  doubt.
- [ ] **Secrets stripped from tool results.** Env vars, tokens, signing secrets and keys in a response are
  removed before they reach a tool.
- [ ] **Local files only inside allowlisted directories.** An explicit allowlist env, `realpath` on both sides,
  a separator-suffixed prefix match, and no FIFOs or devices.
- [ ] **Download host restrictions.** https only, redirect hops re-checked, public hosts only
  (`shared/lib/public-https-fetch.mjs`), streaming size caps, and the provider's documented delivery hosts where
  feasible.
- [ ] **Caps and timeouts.** Row, byte, item and amount caps (for example a per-call budget cap that defaults to
  refusing), tool-result truncation, and timeouts that fit inside the manifest `limits.timeout_ms`. Large
  transfers get their own `timeoutMs`.
- [ ] **Writes are not retried after an unknown outcome.** Such failures are `retryable: false` and say how to
  check what happened. Idempotent POST reads use `idempotent: true`.

Reference examples: `stripe` (amount caps, node-only money movement), `meta-api` (post, engage and DM opt-ins
plus a recipient allowlist), `meta-ads` (writes opt-in, per-call budget cap), `local-files` and `sftp`
(directory allowlists), `shell-exec` (command rules).

## Tests
- Run everything with `npm test` at the repo root. It runs the shared tests, every plugin's `test/*.test.mjs`,
  and the sync, status-label and reserved-parameter checks.
- **Contract tests for every operation.** Declarative plugins use `describeRestPluginContract` (see
  [Contract tests](docs/declarative-plugins.md#contract-tests)): one case per operation with the literal URL, the
  exact query and the exact body, plus the nodeOnly, `toolPolicy` and `api_request` refusals.
- **TDD for custom code.** Anything beyond the declarative data (hand-written operations, guards, parsers,
  signing) gets a failing test first, then the implementation. Use table-driven request tests.
- **No network in unit tests.** Use fakes (`shared/lib/testing.mjs`, an injected fetch or driver). The only live
  call is the manual check below.
- **No realistic-looking fake secrets.** GitHub push protection blocks strings that look like real keys
  (provider-prefixed tokens, AWS-style ids). Use obvious placeholders such as `"fake-token"` or `"test-api-key"`.
- Cover edge cases: empty strings, numbers given as strings, missing credentials, error mapping (401, 403, 404,
  429, 5xx) and mid-body failures for downloads.

### One live check with an invalid credential
Before you open the PR, run your example once against the real service with a deliberately invalid credential
(or a real read for a public no-auth API). Never use a real account and never run a write.

```bash
npm run sync && npm test
GRAPHRT_PLUGIN_PATH=$PWD graphrt plugin info <plugin>
graphrt run <plugin>/example.yaml --plugins .    # expect a clean auth_error
```

Put the exact error in the PR description. This is why most plugins are `beta`, not `stable` (see
[status labels](#status-labels)).

## What each plugin needs

```
<plugin>/
  definition.mjs         # defineRestPlugin({...}) or the hand-written definition
  plugin.mjs             # startPlugin(pluginDefinition), same three lines as every plugin
  package.json
  README.md
  icon.svg               # generated by `npm run icons` from icons.json
  example.yaml           # a READ operation that runs as-is
  test/contract.test.mjs
  lib/shared/            # generated by `npm run sync`
  graphrt-plugin.json    # generated
  OPERATIONS.md          # generated
```

### README.md
Follow [`open-meteo/README.md`](open-meteo/README.md) and [`postgres/README.md`](postgres/README.md). Required
sections:

- **Overview:** what it does and which API and version it targets. The `**Status:**` line under the title is
  kept correct by `npm run sync`; add a `> **Warning:**` blockquote for ToS risks.
- **Environment variables:** a table with every variable, whether it is required, and what it does, including
  every `*_TOOL_ALLOW_*` opt-in and allowlist.
- **Credentials:** how to get them, step by step.
- **Scopes:** the scopes, permissions or app approvals each group of operations needs.
- **Pricing:** what is billed, free tier and rate limits; call out paid operations.
- **Agent policy:** which operations are node only, which need an opt-in or allowlist, and which `api_request`
  paths are refused for tools.
- **Errors:** the error kinds the plugin returns (`auth_error`, `rate_limited`, ...) and what to do about them.

Also keep the prerequisites, installation and license sections the existing plugins have.

### icon.svg
Add a line for the plugin to [`icons.json`](icons.json) and run `npm run icons` (after `npm ci` at the repo root).
Brand plugins use the brand's [Simple Icons](https://simpleicons.org) mark; when Simple Icons has none, and for
generic or local plugins, pick a [Lucide](https://lucide.dev) glyph for the category. Never copy a logo from a
brand's website. [docs/icons.md](docs/icons.md) covers the sources, licences, trademark note, the SVG allowlist
`npm test` enforces, and how icons reach the catalog.

### example.yaml
A short workflow that uses a **read** operation, runs with `graphrt run <plugin>/example.yaml --plugins .`, and
has a comment that says how to run it and which env vars it needs.

### Root README row
Add one row to the plugin table in [README.md](README.md#plugins):

```
| [my-api](my-api/) | beta | none | One sentence: API, main operations, notable safety rules | 12 |
```

The Status and ToS risk cells are overwritten by `npm run sync` from `plugin-status.json`. The last column is the
number of operations (nodes) listed in the generated `OPERATIONS.md`.

### plugin-names.json entry
Add the plugin's display name to [`plugin-names.json`](plugin-names.json), e.g. `"currency-rates": "Currency Rates"`.
Use the brand's own spelling ("GitHub", "OpenAI Images", "WhatsApp Cloud API"), at most 60 characters. The
catalog publishes it as `display_name` and the desktop app shows it; `npm test` fails if a plugin has none.

### plugin-status.json entry
Add an entry for your plugin (`npm run sync` fails if a plugin has none):

```json
"my-api": {
  "status": "beta",
  "reason": "Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error).",
  "tos_risk": "none"
}
```

<a id="status-labels"></a>
**Choosing `status`:**

| Status | When to use it |
|--------|----------------|
| `stable` | Verified end to end with real use: a local plugin whose live run exercised the real behaviour, a public no-auth API read live, or a database client run against a real server. A new plugin is rarely `stable` on its first PR |
| `beta` | Official API, reviewed and unit-tested with fakes, checked live only with an invalid credential. The normal choice |
| `experimental` | Unofficial or reverse-engineered access, scraping, automation that risks the account, or key parts (such as request signing) not yet verified against the live service |

**Choosing `tos_risk`:**

| Risk | When to use it |
|------|----------------|
| `none` | Used as the provider intends under its standard developer terms |
| `low` | Official API, but content, spam, messaging or personal-data rules can be broken by careless use |
| `medium` | The provider's automation or data-protection rules restrict what agents commonly do with it |
| `high` | The access itself is against the terms, or the terms forbid the automation the plugin enables |

`medium` and `high` entries must include `tos_notes` (the clauses and mitigations). Run `npm run sync` afterwards
to update the READMEs and the table.

## Commits and pull requests

### Commits
- [Conventional commits](https://www.conventionalcommits.org/): `feat(<plugin>): add <API> plugin`,
  `fix(<plugin>): ...`, `docs: ...`, `ci: ...`, `test(<plugin>): ...`.
- **One commit per plugin** for a new plugin: definition, tests, README, example, status entry, README row and
  the regenerated files together. A PR adding several plugins has one commit for each.
- Keep unrelated changes out. Regenerated files belong in the commit that caused them.

### Pull requests
- The PR template ([.github/pull_request_template.md](.github/pull_request_template.md)) loads automatically.
  Fill in the test plan honestly: say what you did and did not verify against the real API.
- Do not include credentials, real account ids, personal data or recorded real responses.

### What CI runs
[`ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to `main` (Ubuntu, Node 22):

1. `scripts/install-plugin-dependencies.sh`: `npm ci` for plugins with dependencies (fails on a missing lockfile).
2. `npm run check`: `shared/lib` copies, manifests, `OPERATIONS.md` and status labels are in sync.
3. `npm test`: shared tests, every plugin's tests, the sync and status checks and the reserved-parameter check.
   Integration tests that need ffmpeg, tesseract, a browser, sshd or a database skip cleanly in CI.

Run `npm run check && npm test` locally first. A red CI run blocks review.

## Review process
Reviewers check, in this order:

1. **Correctness against the official docs.** Endpoints, methods, parameters, API version, auth scheme, error
   shapes and pagination are compared with the provider's documentation. Link the pages you used in the PR.
2. **The agent-safety checklist.** Every operation is classified (node only, opt-in, allowlist, free tool) and the
   README matches the code.
3. **Test quality.** Every operation has a contract test with exact URL, query and body; custom code was written
   test first; negative paths are covered; no network; no realistic secrets.
4. **Repo hygiene.** Generated files are in sync, the README sections are complete, the root README row,
   `plugin-status.json` entry and `example.yaml` exist, and the commits follow the conventions.
5. **ToS review.** The `tos_risk` rating and notes match the provider's terms.

Expect change requests; most plugins go through a round or two.

### Promoting status labels
- Labels change in `plugin-status.json` (then `npm run sync`), in a PR that says what was verified.
- **`beta` to `stable`** needs verified real use: someone ran the plugin's operations (reads, and writes where
  safe) against a real account or server and reports it in the PR, with the date. Local plugins and databases
  count when a live run exercised the real behaviour.
- **`experimental` to `beta`** needs the unverified parts (signing, an unofficial access path) confirmed against
  the live service, and for plugins that are experimental because of ToS, a fresh reading of the terms.
- A plugin can be demoted when it breaks or its provider changes its terms. Update `tos_risk` and
  [docs/tos-audit.md](docs/tos-audit.md) whenever a provider's terms change.

## Releases
Maintainers do the releasing; contributors never tag or publish.

- Each plugin version is its own GitHub Release, tagged `<plugin>-v<version>` (a pre-release while the version is
  0.x), with the asset `<plugin>-<version>.tar.gz`. A published release is never modified.
- To ship a change, **bump the version** in `definition.mjs` (the manifest is generated from it) or, for a plugin
  without a definition such as `google-maps-scraper`, in `graphrt-plugin.json`. Mention the bump and a short
  changelog in the PR. A new plugin starts at `0.1.0`.
- Pushing the tag runs [`release.yml`](.github/workflows/release.yml). It checks that the tag matches the manifest
  version, re-checks the generated files, tests the release tooling, then tests, packs and verifies the plugin
  and refreshes the `catalog` release (`index.json`, `SHA256SUMS` and new plugin icons).
- Maintainers can also run the workflow by hand (optionally as a `dry_run`) to publish every plugin whose version
  has no release yet.
- Locally, the same steps are `npm run pack:plugins [name...]`, `npm run verify:plugins dist/*.tar.gz` and
  `npm run publish:plugins`. See [Development](README.md#development).

## License
By contributing you agree that your work is licensed under the Apache-2.0 license of this repository.
