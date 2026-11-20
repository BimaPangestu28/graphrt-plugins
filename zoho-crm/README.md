# zoho-crm

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Zoho CRM REST API v8](https://www.zoho.com/crm/developer/docs/api/v8/) in any Zoho data center: list, get,
search and COQL-query records of any module, related records, insert, update, upsert and delete records, module,
field and related-list metadata, users and the organization.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The data
center, the `Zoho-oauthtoken` header and the token refresh are in [`lib/zoho-auth.mjs`](lib/zoho-auth.mjs).

## Features
- **Metadata:** `list_modules`, `list_fields`, `list_related_lists`, `list_users`, `get_org`
- **Reads:** `list_records` (page_token paging past 2,000 records), `get_record`, `search_records` (one of
  criteria, email, phone or word is required), `coql_query` (SQL-like SELECT), `list_related_records` (e.g. an Account's Contacts or Notes)
- **Writes:** `insert_records`, `update_records`, `upsert_records` (up to 100 records a call), `delete_records`
  (node only)
- **`api_request`:** any other v8 endpoint (GET only for agents), e.g. `/settings/layouts?module=Leads`

Lists return the records in `data`; pass `next_cursor` back as `cursor` for the next page. Records use field API
names (`list_fields`). Writes return Zoho's per-record results in `data[]` (`code`, `status`, `details.id`): a call
can succeed for some records and fail for others (HTTP 207), so check each status. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Zoho CRM account and a client from the [Zoho API Console](https://api-console.zoho.com/)

## Installation
```bash
graphrt plugin install ./zoho-crm
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `ZOHO_CLIENT_ID` | yes* | Client id from the API Console |
| `ZOHO_CLIENT_SECRET` | yes* | Client secret |
| `ZOHO_REFRESH_TOKEN` | yes* | Refresh token (offline access) |
| `ZOHO_DATA_CENTER` | outside the US | `us` (default, zoho.com), `eu`, `in`, `au`, `jp`, `ca`, `cn`, `sa` or `uk`: picks both the API host (`www.zohoapis.<tld>`) and the accounts host for tokens |
| `ZOHO_ACCESS_TOKEN` | no | A short-lived access token used as is when the refresh trio is not set (expires after an hour) |

\* Or `ZOHO_ACCESS_TOKEN`. A node can pass `access_token` (used as is; needs `--trust-plugin zoho-crm`).

### Getting the credentials
1. In the API Console create a **Self Client** (or a server-based client), and note the client id and secret.
2. Generate a grant code with the scopes the workflows need, e.g.
   `ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.users.READ,ZohoCRM.org.READ,ZohoCRM.coql.READ,ZohoSearch.securesearch.READ`
   (read-only workflows: `ZohoCRM.modules.READ` instead of `.ALL`).
3. Exchange it for a refresh token at your data center's accounts host
   (`POST https://accounts.zoho.<tld>/oauth/v2/token?grant_type=authorization_code&code=...&client_id=...&client_secret=...`)
   and set `ZOHO_REFRESH_TOKEN`. Use the accounts host of the data center where your CRM account lives.

The plugin fetches access tokens itself, caches them for their lifetime (one hour), and on `INVALID_TOKEN` gets a
fresh one and retries once. Calls run with the user's permissions: use a dedicated user with only the modules
the workflows need.

**Pricing / limits:** API access is included in Zoho CRM editions; each call costs API credits from a daily
allowance that depends on the edition and number of licenses (COQL queries with a LIMIT above 200 cost 2–3
credits). Over the limit, Zoho answers 429 (`rate_limited`).

## Quick Start
```bash
ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... ZOHO_DATA_CENTER=eu \
  graphrt run zoho-crm/example.yaml --plugins .
```

## Usage
```yaml
- id: leads
  type: zoho-crm.coql_query
  select_query: "select Last_Name, Email, Lead_Status from Leads where Created_Time > '2026-11-01T00:00:00+00:00' limit 0, 200"
- id: add
  type: zoho-crm.upsert_records
  module: Leads
  records: [{ Last_Name: "{{#start.name#}}", Email: "{{#start.email#}}", Lead_Source: Web }]
  duplicate_check_fields: [Email]
```
COQL and search criteria are passed as written: escape quotes (COQL) and `(`, `)`, `,` (criteria) in values that
come from user input.

## Agent policy
- Reads, `insert_records`, `update_records` and `upsert_records` are tools.
- Writes send `trigger: []` by default, so no workflow rules (which can send emails), approvals or blueprints run;
  a caller has to ask for them with `trigger: ["workflow"]` etc.
- `delete_records` is node only.
- `api_request` is GET only for agents, and limited to the standard modules' records (`/Leads`, `/Contacts`,
  `/Accounts`, `/Deals`, `/Tasks`, ...), `/settings/modules|fields|layouts|related_lists|custom_views|pipeline`,
  `/users` and `/org`. Other GET endpoints return Deluge variables (often API keys) and notification channel
  tokens (`/actions/watch`). Paths are percent-decoded repeatedly before the check, and `.`, `..`, empty segments
  and encoded slashes or backslashes are refused. Custom modules stay readable through `list_records` and
  `get_record`.

## Per-user tokens (multi-user agents)

Set `ZOHO_CRM_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin zoho-crm`):

```yaml
tools: [zoho-crm/list_modules]
tool_context:
  zoho-crm:
    access_token: "{{#start.zoho_crm_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Zoho OAuth access token of that user, from the data center set in `ZOHO_DATA_CENTER`.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `ZOHO_ACCESS_TOKEN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
Zoho errors are `{"code", "details", "message", "status": "error"}`: `INVALID_TOKEN`/`AUTHENTICATION_FAILURE` →
`auth_error`, `OAUTH_SCOPE_MISMATCH`/`NO_PERMISSION` → `permission_denied`, `INVALID_URL_PATTERN` → `not_found`,
`INVALID_DATA`, `INVALID_MODULE`, `INVALID_QUERY`, `MANDATORY_NOT_FOUND`, `DUPLICATE_DATA`, `LIMIT_REACHED` →
`invalid_input`, 429 → `rate_limited`. A token endpoint answer like `{"error": "invalid_code"}` (revoked refresh
token) is `auth_error`. A failed `insert_records`, `update_records` or `upsert_records` is never retried after an unknown outcome
(an update may have run workflows): check the records first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the data centers, credential order, token refresh and retry, and error
mapping. Verified live only with invalid credentials (`auth_error`).

## License
Apache-2.0
