# google-ads

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Google Ads API](https://developers.google.com/google-ads/api/docs/start) over REST (`v26`,
`https://googleads.googleapis.com/v26`). It lists the accounts you can access, runs Google Ads Query Language
(GAQL) searches, builds campaign, keyword and search-term reports, pauses and enables campaigns and ad groups,
changes budget amounts, and sends raw mutates from workflow nodes. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)), the shared Google OAuth files and small wrappers in [`lib/`](lib/).

**Status and budget changes spend real money.** Read [Agent policy](#agent-policy) before giving any operation to
an LLM.

## Features
- **Accounts:** `list_accessible_customers` (`customers/<id>` resource names)
- **GAQL:** `search` (10,000 rows per page, `next_cursor` = `nextPageToken`), `search_stream` (all rows as batches).
  Queries must start with `SELECT`; a `PARAMETERS` clause is refused.
- **Reports** (GAQL built from validated parts, returned as `data.query` with `data.rows`):
  `get_campaign_performance`, `get_keyword_performance`, `get_search_terms`. They take `date_range`
  (`TODAY`, `YESTERDAY`, `LAST_7_DAYS`, `LAST_14_DAYS`, `LAST_30_DAYS`, `THIS_MONTH`, `LAST_MONTH`, ...) or
  `start_date` + `end_date`, allowlisted `metrics`, numeric `campaign_id` / `ad_group_id` filters and `row_limit`.
- **Changes:** `set_campaign_status`, `set_ad_group_status` (ENABLED / PAUSED), `set_campaign_budget_amount`
  (`amount_micros`); each takes `validate_only` for a dry run
- **Node only:** `mutate_campaigns`, `mutate_campaign_budgets`, `mutate_ad_groups`, `mutate_ad_group_ads`,
  `mutate_ad_group_criteria` and `mutate` (`googleAds:mutate`, several resource types at once): create, update and
  remove operations in the REST shape, with `partial_failure`, `validate_only` and `response_content_type`
- **`api_request`:** any other endpoint (GET only and allowlisted paths for agents), e.g. `/googleAdsFields/<name>`

`customer_id` accepts `1234567890` or `123-456-7890`. Money is in micros: `20000000` is 20.00 in the account
currency. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Ads account (or manager account), and a Google Cloud project with the Google Ads API enabled

## Installation
```bash
graphrt plugin install ./google-ads
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | one credential is required | OAuth client and a refresh token with the `https://www.googleapis.com/auth/adwords` scope (preferred) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | " | Path to a service account key file; the service account must be added as a user of the Google Ads account |
| `GOOGLE_ACCESS_TOKEN` | " | A ready access token (expires after an hour; used when no grant above is set) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | when acting through a manager account | Manager (MCC) customer id, sent as `login-customer-id` (dashes are removed) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | no | Sent as `developer-token` when set (see below). Redacted everywhere |
| `GOOGLE_ADS_TOOL_ALLOW_WRITES` | no | `1` lets agent tools pause/enable campaigns and ad groups and change budget amounts; see the two rows below |
| `GOOGLE_ADS_TOOL_CUSTOMER_IDS` | for any agent write | Comma-separated customer ids agents may change (`1234567890` or `123-456-7890`). Unset refuses every agent write |
| `GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS` | for agent budget changes and enabling | Highest `amount_micros` an agent may set, and highest campaign budget a campaign or ad group may have to be enabled by an agent. Unset or `0` refuses every agent budget change and enable |
| `GOOGLE_ADS_TOOL_ALLOW_LEADS` | no | `1` lets agent GAQL read `lead_form_submission_data`, `local_services_lead`, `local_services_lead_conversation`, `local_services_employee`, `customer_user_access`, `customer_user_access_invitation` and `change_event` (personal data: lead answers, user emails, employee names) |
| `GOOGLE_ADS_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Micros.** Budgets are `amount_micros` in the account currency: `20000000` is USD 20.00 on a USD account and
IDR 20 on an IDR account (`50000000000` is IDR 50,000). The cap is compared with the value as sent. Most budgets
are daily; a budget with a custom period caps its whole period the same way.

**Developer token and access levels.** Google's API policy changed on 2026-09-09: developer tokens were sunset and
the server ignores the `developer-token` header (Google says a future major version will reject it). API access is
now a level of the **Google Cloud project**:

| Level | What it allows |
|---|---|
| Test | Test accounts only (granted when the API is enabled) |
| Explorer | 2,880 operations a day on production accounts (requested in the Cloud Console) |
| Basic | 15,000 operations a day |
| Standard | Unlimited |

A Test-level project calling a production account gets `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`
(`permission_denied`). For older setups that still have a developer token (test-account access vs Basic/Standard
access was approved per token), set `GOOGLE_ADS_DEVELOPER_TOKEN`; it is sent but has no effect on v26.

**Getting credentials:**
1. In the Google Cloud Console enable the Google Ads API, create an OAuth client (Desktop or Web), and request the
   access level you need.
2. Get a refresh token for a Google user with access to the ads account, with the `adwords` scope (e.g. the OAuth
   Playground with your own client).
3. If that user reaches the account through a manager account, set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the manager id.

**Pricing:** API calls are free within your access level's daily operations. Enabling campaigns and raising budgets
spends money.

## Quick Start
```bash
GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... graphrt run google-ads/example.yaml --plugins .
```
Set `customer_id` in the example to one of your accounts.

## Usage
```yaml
- id: rows
  type: google-ads.search
  customer_id: "123-456-7890"
  query: >-
    SELECT campaign.id, campaign.name, campaign.campaign_budget, metrics.cost_micros
    FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 20
- id: pause
  type: google-ads.set_campaign_status
  customer_id: "1234567890"
  campaign_id: "111"
  status: PAUSED
- id: budget
  type: google-ads.set_campaign_budget_amount
  customer_id: "1234567890"
  budget_id: "333"          # from campaign.campaign_budget: customers/1234567890/campaignBudgets/333
  amount_micros: 20000000   # 20.00 in the account currency
  validate_only: true
```

## Agent policy
- **Reads** (`list_accessible_customers`, `search`, `search_stream`, the three reports) are agent tools. GAQL only
  reads; queries that do not start with `SELECT` or contain `PARAMETERS` are refused, and the reports accept only
  allowlisted metrics, date literals or checked dates and numeric ids.
- **Leads and users** (`GOOGLE_ADS_TOOL_ALLOW_LEADS=1`): agent GAQL that names `lead_form_submission_data`,
  `local_services_lead`, `local_services_lead_conversation`, `local_services_employee`, `customer_user_access`,
  `customer_user_access_invitation` or `change_event` (user emails) anywhere outside string literals is refused without the opt-in (the query is tokenised, so names are compared whole).
- **Customer ids** must be numeric (dashes allowed) for search, search_stream and the reports, for every caller.
- **Account scoping** (every agent write): `customer_id` must be in `GOOGLE_ADS_TOOL_CUSTOMER_IDS`. The resource
  names are built from that customer id, so the change can only touch that account.
- **Pausing** (`GOOGLE_ADS_TOOL_ALLOW_WRITES=1` + account scoping): `set_campaign_status` and `set_ad_group_status`
  send one `update` of `status`, PAUSED (or ENABLED, below). REMOVED is node only through the raw mutates.
- **Enabling** (also `GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS`): ENABLED starts spending the campaign budget that is
  already set. The plugin reads it first with GAQL (for an ad group: its campaign's budget) and refuses when it is
  over the cap, when none is found, or when the read fails.
- **Budgets** (`GOOGLE_ADS_TOOL_ALLOW_WRITES=1` + account scoping **and** `GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS`):
  `set_campaign_budget_amount` amounts over the cap are refused before anything is sent.
- **What the cap is not:** it is checked per call and per object, not as a total across campaigns, calls or days:
  an agent can still enable several campaigns, each within the cap. Google can also spend up to 2x a campaign's
  average daily budget on a given day (while keeping the month within 30.4x the daily budget). A shared budget
  is counted once per campaign.
- **Node only:** every raw mutate (`mutate_*`, `mutate`): creates, removes and any other change.
- **Mutates are `unsafe`:** never retried after a 5xx or network failure; the error says the outcome is unknown and
  what to search to check. Use `validate_only` first where you can.
- `api_request` is GET-only for agents and limited to `/customers:listAccessibleCustomers` and
  `/googleAdsFields/<name>`. Invoices, payments accounts, identity verification and long-running operations are
  refused. `access_token`, `refresh_token` and `developer_token` fields are removed from tool results.

## Per-user tokens (multi-user agents)

Set `GOOGLE_ADS_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin google-ads`):

```yaml
tools: [google-ads/list_accessible_customers]
tool_context:
  google-ads:
    access_token: "{{#start.google_ads_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Google OAuth access token of that user with the `adwords` scope; your app's `GOOGLE_ADS_DEVELOPER_TOKEN` (and `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, if set) are still read from the env.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `GOOGLE_ACCESS_TOKEN`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Account allowlists and spend caps (`GOOGLE_ADS_TOOL_CUSTOMER_IDS` and `GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS`) are per process, so they apply to every end user: list
  every account your users may change, or leave them unset to keep agent writes refused.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
The first `GoogleAdsFailure` message is shown (e.g. `Oauth token is invalid. (UNAUTHENTICATED)`), else
`error.message`. `UNAUTHENTICATED` / 401 is `auth_error`, `PERMISSION_DENIED` / 403 `permission_denied` (user
without access, wrong `login-customer-id`, project access level), `INVALID_ARGUMENT` `invalid_input` (GAQL errors),
`NOT_FOUND` `not_found`, `RESOURCE_EXHAUSTED` / 429 `rate_limited`.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/agent-policy.test.mjs` covers GAQL checks, the
reports, the simple mutates, the budget cap, no retries for mutates, headers, the `api_request` allowlist and
errors. Verified live only with an invalid token (`auth_error`); not tested against a real ads account.

## License
Apache-2.0
