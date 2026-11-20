# meta-ads

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Meta Marketing API](https://developers.facebook.com/docs/marketing-api) (Facebook and Instagram ads on the Graph
API, default version `v27.0`). It reads ad accounts, campaigns, ad sets, ads, creatives and insights (with
synchronous and asynchronous reports), lists Lead Ads forms and their leads, and changes status and budgets. It is
built with the declarative REST layer ([`definition.mjs`](definition.mjs)) plus small agent-safety wrappers in
[`lib/`](lib/).

**Budget changes spend real money.** Read [Agent policy](#agent-policy) before giving any operation to an LLM.

## Features
- **Accounts:** `list_ad_accounts` (`/me/adaccounts`), `get_ad_account` (currency, time zone, spend, status)
- **Structure:** `list_campaigns`, `list_ad_sets`, `list_ads`, `list_ad_creatives` (with `effective_status` and
  `filtering`), `get_campaign`, `get_ad_set`, `get_ad`
- **Insights:** `get_insights` (fields, `date_preset` or `time_range`, `time_increment`, `level`, `breakdowns`,
  `action_breakdowns`, attribution windows, filtering, sort), `run_insights_report` (async report run for large
  ranges, waits until `Job Completed`), `get_insights_report_rows` (paginated rows of a finished run)
- **Lead Ads:** `list_lead_forms` (Instant Forms of a Page), `list_leads` (leads of a form or an ad, filtered by
  `time_created`)
- **Changes:** `set_status` (ACTIVE / PAUSED), `set_budget` (daily or lifetime budget of a campaign or ad set)
- **Node only:** `create_campaign`, `create_ad_set`, `create_ad_creative`, `create_ad` (all PAUSED by default,
  `execution_options: ["validate_only"]` to dry-run), `delete_object`
- **`api_request`:** any other Graph endpoint (GET only and allowlisted paths for agents), e.g.
  `/act_<id>/adrules_library`

`ad_account_id` accepts `act_123` or `123`. Lists use Graph cursors: pass `next_cursor` back as `cursor` (sent as
`after`). List arguments (`effective_status`, `breakdowns`, `sort`, ...) are lists; they are sent as JSON arrays.
Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Meta app with the Marketing API product and a user or system user access token for the ad accounts

## Installation
```bash
graphrt plugin install ./meta-ads
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `META_ADS_ACCESS_TOKEN` | yes | User or (better) system user access token with the permissions below, sent as `Authorization: Bearer` |
| `META_GRAPH_VERSION` | no | Graph API version, default `v27.0` (shared with `meta-api`; e.g. `v26.0`) |
| `META_ADS_TOOL_ALLOW_WRITES` | no | `1` lets agent tools pause/activate (`set_status`) and change budgets (`set_budget`); see the two rows below |
| `META_ADS_TOOL_ACCOUNT_IDS` | for any agent write | Comma-separated ad accounts agents may change (`act_123` or `123`). Unset refuses every agent write |
| `META_ADS_TOOL_MAX_DAILY_BUDGET` | for agent budget changes and activations | Highest budget an agent may set, or activate an object with, in the **ad account currency's minor units**. Unset or `0` refuses every agent budget change and activation |
| `META_ADS_TOOL_ALLOW_LEADS` | no | `1` lets agent tools read leads (form answers are personal data) |
| `META_ADS_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

**Minor units.** Meta budgets are in the account currency's smallest unit: `2000` is USD 20.00 or EUR 20.00. For
currencies without a minor unit in Meta (JPY, KRW, IDR and others, see
[currencies](https://developers.facebook.com/docs/marketing-api/currencies)) the number is whole units: `50000` is
IDR 50,000. The cap is compared with the value as sent, and it also caps lifetime budgets (so set it with the
lifetime budgets you allow in mind, or change lifetime budgets with nodes).

**Why not `META_ACCESS_TOKEN`?** `meta-api` uses a *Page* access token, which cannot read ad accounts. The ads
token is a user or system user token. One system user token can hold both sets of permissions: then set both
variables to the same value.

**Getting a token and permissions:**
1. Create an app at [developers.facebook.com](https://developers.facebook.com/apps) (type Business) and add the
   Marketing API product.
2. In Business Settings → System users, create a system user, give it the ad accounts (and Pages for Lead Ads), and
   generate a token for the app with:
   - `ads_read` (all reads), `ads_management` (status, budget, creates, deletes),
   - `leads_retrieval` plus `pages_show_list`, `pages_read_engagement`, `pages_manage_ads` (Lead Ads).
3. **App Review:** to use ad accounts you do not own, or to leave the heavily rate-limited development tier, the app
   needs Advanced Access for `ads_read`/`ads_management` (and `leads_retrieval`) through App Review and Business
   Verification, and the Marketing API "full access" tier (formerly Advanced/Standard Access). Without it calls
   still work on your own accounts with low limits.
4. Reading leads may need a Page access token of the form's Page: pass it as the node's `access_token`.

**Pricing:** API calls are free. Activating ads and raising budgets spends money on the account's payment method.

**Rate limits:** Meta throttles per app, ad account and business use case. Codes 4, 17, 32, 613 and 80000–80014
are `rate_limited`; the `X-Business-Use-Case-Usage` header says when access returns.

## Quick Start
```bash
META_ADS_ACCESS_TOKEN=... graphrt run meta-ads/example.yaml --plugins .
```
The example lists your ad accounts and the last 7 days of spend per campaign of the first one.

## Usage
```yaml
- id: report
  type: meta-ads.run_insights_report
  object_id: act_1234567890
  level: ad
  time_range: { since: "2026-01-01", until: "2026-10-31" }
  breakdowns: [publisher_platform]
- id: rows
  type: meta-ads.get_insights_report_rows
  report_run_id: "{{#report.data.job_id#}}"
  limit: 500
- id: pause
  type: meta-ads.set_status
  object_id: "120200000000001"
  status: PAUSED
- id: budget
  type: meta-ads.set_budget
  object_id: "120200000000001"
  daily_budget: 2000       # USD 20.00 on a USD account
```

## Agent policy
- **Reads** are agent tools. `access_token` fields (Page tokens) are removed from every tool result at any depth.
- **Leads** (`META_ADS_TOOL_ALLOW_LEADS=1`): `list_leads`. Any tool result that contains lead answers
  (`field_data`, e.g. `get_ad` with `fields=leads{field_data}` or `api_request` on a lead id) is refused without the
  opt-in. `list_lead_forms` (form names and counts) is a normal read.
- **Account scoping** (every agent write): agents pass `object_type` (campaign, ad_set or ad); the plugin reads the
  object's `account_id` first and refuses unless it is in `META_ADS_TOOL_ACCOUNT_IDS`. A failed read refuses.
- **Pausing** (`META_ADS_TOOL_ALLOW_WRITES=1` + account scoping): `set_status` with PAUSED. Archiving and deleting
  are not accepted (`delete_object` is node only).
- **Activating** (also `META_ADS_TOOL_MAX_DAILY_BUDGET`): ACTIVE starts spending the budget the object already has.
  The plugin reads the effective budget (the object's own daily or lifetime budget, else its ad set's, else its
  campaign's, as under campaign budget optimization) and refuses when it is over the cap, when no budget is found,
  or when the read fails.
- **Budgets** (`META_ADS_TOOL_ALLOW_WRITES=1` + account scoping **and** `META_ADS_TOOL_MAX_DAILY_BUDGET`):
  `set_budget` amounts over the cap, or calls without an amount, are refused before anything is sent.
- **What the cap is not:** it is checked per call and per object. It is not a total across objects, calls or days:
  an agent can still activate several objects, each within the cap. Daily budgets can also overdeliver: Meta may
  spend up to about 75% more than a daily budget on a given day (about 1.75x) while keeping the weekly average.
- **Fields and ids:** every agent `fields` argument (and `api_request` path and query) is refused when it uses field
  aliases (`.as(...)`, which rename fields past the guards), names a token or secret, or asks for `leads` /
  `field_data` without the leads opt-in. Agent path ids must be numeric: `act_<number>` or the number for ad
  accounts (and insights objects), the number or `<number>_<number>` for everything else, so `me` is refused.
- **Node only:** `create_campaign`, `create_ad_set`, `create_ad_creative`, `create_ad`, `delete_object`.
- `api_request` is GET-only for agents and limited to `/me/adaccounts`, `/act_<id>` and its ad edges (campaigns,
  adsets, ads, adcreatives, insights, adimages, advideos, customaudiences, adspixels, ads_volume, reachestimate,
  delivery_estimate), and `/<id>` with ad edges. `/me/accounts` and other edges that return Page tokens, the leads
  edge (without the opt-in) and anything else are refused, and so is any call whose path or query mentions a token
  or secret (e.g. `fields=access_token`).

## Per-user tokens (multi-user agents)

Set `META_ADS_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin meta-ads`):

```yaml
tools: [meta-ads/list_ad_accounts]
tool_context:
  meta-ads:
    access_token: "{{#start.meta_ads_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Meta user access token of that user with `ads_read` (and `ads_management` for the capped writes).
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `META_ADS_ACCESS_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Account allowlists and spend caps (`META_ADS_TOOL_ACCOUNT_IDS` and `META_ADS_TOOL_MAX_DAILY_BUDGET`) are per process, so they apply to every end user: list
  every account your users may change, or leave them unset to keep agent writes refused.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
Graph errors show `error_user_msg` or `message` and the code, e.g. `API error 400: Invalid parameter (100)`.
190 (bad or expired token) is `auth_error`, 10 and 200–299 `permission_denied` (missing permission or App Review),
100 and 2635 (deprecated version) `invalid_input`, the throttling codes `rate_limited`. Writes are never retried
after a 5xx or network failure: the error says the outcome is unknown and how to check.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/agent-policy.test.mjs` covers the budget cap,
opt-ins, lead and token guards, the `api_request` allowlist and error codes. Verified live only with an invalid
token (`auth_error`); not tested against a real ad account.

## License
Apache-2.0
