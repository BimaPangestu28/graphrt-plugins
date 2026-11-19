# salesforce

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Salesforce REST API](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/) of one org: SOQL
queries with batch paging, SOSL search, sObject records (get, create, update, upsert by external id, delete),
object metadata (describe), org limits, updated/deleted record ids and recently viewed records.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The
instance URL, API version and OAuth grant come from the environment ([`lib/salesforce-org.mjs`](lib/salesforce-org.mjs)).

## Features
- **Metadata:** `get_limits`, `describe_global` (every sObject), `describe_sobject` (fields, picklists, relationships)
- **Queries:** `query` (SOQL), `query_all` (incl. deleted/archived), `query_more` (next batch), `search` (SOSL),
  `list_recently_viewed`, `get_updated` / `get_deleted` (ids changed in a time range, for sync)
- **Records:** `get_record`, `get_record_by_external_id`, `create_record`, `update_record` (PATCH),
  `upsert_record` (PATCH by external id), `delete_record` (node only)
- **`api_request`:** any other endpoint under `/services/data/<version>` (GET only for agents), e.g.
  `/sobjects/Account/listviews`, `/composite/...` from nodes

`query` returns Salesforce's body: `{totalSize, done, records, nextRecordsUrl}`. When `done` is false, pass
`nextRecordsUrl` (or just its locator) as `query_locator` to `query_more` until `done` is true. Records are written
with a `fields` object of field API names, e.g. `{"Name": "Acme", "Industry": "Retail"}`. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Salesforce org with API access (Enterprise, Unlimited, Developer or Performance edition, or API add-on) and an
  External Client App or Connected App

## Installation
```bash
graphrt plugin install ./salesforce
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `SALESFORCE_INSTANCE_URL` | yes | The org's URL, e.g. `https://acme.my.salesforce.com` (must be an https `*.salesforce.com` host, no path) |
| `SALESFORCE_CLIENT_ID` | yes | Consumer key of the app |
| `SALESFORCE_CLIENT_SECRET` | yes | Consumer secret |
| `SALESFORCE_REFRESH_TOKEN` | for the refresh token flow | A user's refresh token; when unset, the client credentials flow is used |
| `SALESFORCE_LOGIN_URL` | no | Token host: default `https://login.salesforce.com` for refresh tokens (`https://test.salesforce.com` for sandboxes) and the instance URL for client credentials |
| `SALESFORCE_API_VERSION` | no | REST API version, default `v66.0` (Spring '26); e.g. `v64.0` |

A node can pass `access_token` (a Salesforce access token used as-is; needs `--trust-plugin salesforce`).

### Getting the credentials
1. Setup → **External Client App Manager** (or App Manager → New Connected App) → enable OAuth, scopes `api` and
   `refresh_token, offline_access`, a callback URL, and note the consumer key and secret.
2. **Refresh token flow** (acts as a user): run the web server flow once
   (<https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_web_server_flow.htm>) and set
   `SALESFORCE_REFRESH_TOKEN`.
3. **Client credentials flow** (server to server): enable it in the app's OAuth policies and choose a
   **Run As** user; leave `SALESFORCE_REFRESH_TOKEN` unset. The token is requested from the org's My Domain.

The plugin requests access tokens itself, caches them, and refreshes once when a call answers
`INVALID_SESSION_ID`. Every request runs with the permissions of the user (or Run As user): use a dedicated
integration user with only the objects and fields the workflows need.

**Pricing / limits:** included in Salesforce editions with API access. Each org has a rolling 24-hour API
request allocation (`get_limits` → `DailyApiRequests`); over it, calls fail with `REQUEST_LIMIT_EXCEEDED`
(`rate_limited`).

## Quick Start
```bash
SALESFORCE_INSTANCE_URL=https://acme.my.salesforce.com SALESFORCE_CLIENT_ID=... SALESFORCE_CLIENT_SECRET=... \
  SALESFORCE_REFRESH_TOKEN=... graphrt run salesforce/example.yaml --plugins .
```

## Usage
```yaml
- id: accounts
  type: salesforce.query
  soql: "SELECT Id, Name FROM Account WHERE CreatedDate = LAST_N_DAYS:7"
- id: lead
  type: salesforce.upsert_record
  sobject: Lead
  external_id_field: Web_Form_Id__c
  external_id: "{{#start.form_id#}}"
  fields: { LastName: "{{#start.name#}}", Company: "{{#start.company#}}", Email: "{{#start.email#}}" }
```
SOQL and SOSL are passed as written: escape quotes in values you insert from user input (`\'`). `update_record`
returns `null` data (204); `create_record` returns `{id, success, errors}`.

## Agent policy
- Reads, `create_record`, `update_record` and `upsert_record` are tools. Record writes can start the org's flows
  and triggers (which may send email); limit what the integration user can edit.
- `delete_record` is node only.
- `api_request` is GET only for agents.

## Errors
Salesforce errors are `[{"message", "errorCode"}]`: `INVALID_SESSION_ID` → `auth_error` (token refreshed once),
`REQUEST_LIMIT_EXCEEDED` (403) → `rate_limited`, `INSUFFICIENT_ACCESS*` → `permission_denied`,
`NOT_FOUND`/`ENTITY_IS_DELETED` → `not_found`, `MALFORMED_QUERY`, `INVALID_FIELD`, `REQUIRED_FIELD_MISSING`,
`FIELD_CUSTOM_VALIDATION_EXCEPTION`, `DUPLICATES_DETECTED` ... → `invalid_input`. Token endpoint errors
(`invalid_grant`, `invalid_client_id`) are `auth_error`. A failed `create_record` is never retried after an unknown
outcome: query for the record first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the env URL checks, grant selection, token refresh, error mapping and
query locators. Verified live only with invalid credentials (`auth_error`).

## License
Apache-2.0
