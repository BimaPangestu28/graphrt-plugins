# pipedrive

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Pipedrive](https://www.pipedrive.com) CRM API.
It lists, reads, searches, creates and updates persons, organizations, deals and activities (API v2), lists
pipelines and stages, and manages notes (API v1). Built with the declarative REST layer
([`definition.mjs`](definition.mjs), see [docs/declarative-plugins.md](../docs/declarative-plugins.md)).

## Features
- **Persons, organizations, deals, activities:** `list_*` (filters, sorting, cursor pagination up to 500 per page),
  `get_*`, `create_*`, `update_*` (PATCH: only the given fields), `delete_*` (node only)
- **Search:** `search_persons` (name, email, phone, notes, custom fields), `search_organizations`, `search_deals`;
  each result is `{result_score, item}`
- **Pipelines:** `list_pipelines`, `list_stages` (ids for `create_deal`)
- **Notes (v1):** `list_notes` (offset pagination), `get_note`, `create_note`, `update_note`, `delete_note` (node only)
- **`get_current_user`:** the token's user and company (`id` for `owner_id`, `company_domain`)
- **`api_request`:** any other endpoint under `/api` (e.g. `/v1/dealFields`, `/v2/products`, `/v1/leads`); agents
  are limited to GET on CRM read paths (see Agent policy)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Pipedrive account with API access

## Installation
```bash
graphrt plugin install ./pipedrive
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---|---|---|
| `PIPEDRIVE_API_TOKEN` | yes | Personal API token, sent in the `x-api-token` header (never in the URL) |
| `PIPEDRIVE_COMPANY_DOMAIN` | no | Your subdomain (`acme` or `acme.pipedrive.com`), as Pipedrive recommends; default `api.pipedrive.com`. Anything that is not a Pipedrive subdomain is refused |
| `PIPEDRIVE_TOOL_API_EXTRA_PATHS` | no | More paths agents may read through `api_request`, comma-separated, `*` matches one segment, e.g. `/v1/goals/*` |

A node may pass `access_token` to use another API token for that call.

**Getting a token:** in Pipedrive, open your profile menu > Personal preferences > API, and copy your personal API
token. It acts as you, with your permissions and visibility. Treat it like a password; regenerating it invalidates
the old one. (OAuth apps from the Marketplace are not supported by this plugin yet.)

**Billing and limits:** API access is part of every paid plan (no per-call charge). Requests are limited by a daily
token budget per company (depending on plan and seats) and burst limits; each endpoint costs tokens (v2 lists 10,
gets 1, searches 20, creates and updates 5, deletes 3). A `429` is reported as `rate_limited`.

## Quick Start
```bash
PIPEDRIVE_API_TOKEN=... graphrt run pipedrive/example.yaml --plugins .
```
The example lists the five most recently updated open deals and the pipelines.

## Usage
```yaml
- id: found
  type: pipedrive.search_persons
  term: "{{#start.email#}}"
  fields: [email]
  exact_match: true
- id: deal
  type: pipedrive.create_deal
  deal_title: "Renewal for {{#start.company#}}"
  person_id: "{{#found.data.0.item.id#}}"
  value: 5000000
  currency: IDR
- id: note
  type: pipedrive.create_note
  deal_id: "{{#deal.data.id#}}"
  content: "Created by graphrt"
```

- `data` is the record for gets, creates and updates, and the array of records (or `{result_score, item}` search
  hits) for lists and searches, with `next_cursor` for the next page.
- `create_deal`/`update_deal` take the deal title as `deal_title` (graphrt reserves `title` on nodes); activities
  take their type as `activity_type`.
- Custom fields are set through `custom_fields` keyed by field key (40-character hash, see `/v1/dealFields`).

## Agent policy
- Reads, creates and updates are tools. Creates are never retried after an unknown outcome (the error says how to
  check); PATCH/PUT updates are retried.
- Deletes (`delete_person`, `delete_organization`, `delete_deal`, `delete_activity`, `delete_note`) are node only.
- Activity `attendees` are not offered (Pipedrive's calendar sync can email them invitations); link persons with
  `participants` instead, or use `api_request` from a node.
- `api_request` as a tool is GET-only and limited to CRM read paths under `/v1` and `/v2` (persons, organizations,
  deals, activities, notes, leads, products, pipelines, stages, filters, item search, field definitions, users,
  projects, files, recents). Webhooks (which hold basic-auth passwords), user connections and settings, billing and
  anything else are refused unless added to `PIPEDRIVE_TOOL_API_EXTRA_PATHS`. Paths are normalized first (decoding,
  `..`, backslashes, case).

## Per-user tokens (multi-user agents)

Set `PIPEDRIVE_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin pipedrive`):

```yaml
tools: [pipedrive/list_persons]
tool_context:
  pipedrive:
    access_token: "{{#start.pipedrive_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an OAuth access token (or personal API token) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `PIPEDRIVE_API_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Situation | Kind |
|---|---|
| Bad or missing token (`401 unauthorized access`) | `auth_error` |
| No permission for a record or feature (403) | `permission_denied` |
| Unknown id (404) | `not_found` |
| Invalid field or value (400) | `invalid_input` (with Pipedrive's message) |
| Rate or daily token limit (429) | `rate_limited` |
| Bad `PIPEDRIVE_COMPANY_DOMAIN` | `invalid_input`, before any request |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite (every operation); `test/pipedrive.test.mjs` covers the
company domain, header auth, error mapping, both pagination styles and the agent `api_request` path policy.
Verified live with an invalid token (`auth_error: API error 401: unauthorized access`).

## License
Apache-2.0
