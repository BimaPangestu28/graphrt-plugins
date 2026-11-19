# tiktok-ads

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[TikTok API for Business](https://business-api.tiktok.com/portal/docs) (Marketing API v1.3,
`https://business-api.tiktok.com/open_api/v1.3`). It reads advertiser info, campaigns, ad groups, ads and integrated
reports, retrieves Instant Form leads, and changes status and budgets. It is built with the declarative REST layer
([`definition.mjs`](definition.mjs)) plus small agent-safety wrappers in [`lib/`](lib/).

**Budget changes spend real money.** Read [Agent policy](#agent-policy) before giving any operation to an LLM.

## Features
- **Reads:** `get_advertiser_info` (name, status, currency, time zone, balance), `list_campaigns`, `list_ad_groups`,
  `list_ads` (with `fields` and `filtering`), `get_report` (synchronous `report/integrated/get`: report type, data
  level, dimensions, metrics, dates or lifetime, filtering, sorting, total metrics)
- **Leads:** `list_lead_forms` (Instant Forms), `get_lead_form_fields`, `get_lead`, `create_lead_download_task`
  (start or check an export of every lead of a form or ad), `download_leads` (saves the CSV/zip)
- **Changes:** `set_campaign_status`, `set_ad_group_status`, `set_ad_status` (ENABLE / DISABLE, up to 20 ids),
  `set_campaign_budget`, `set_ad_group_budgets` (lifetime `budget` now, or daily `scheduled_budget` from tomorrow)
- **Node only:** `create_campaign`, `create_ad_group`, `create_ad` (the request body as in TikTok's docs),
  `delete_campaigns`, `delete_ad_groups`, `delete_ads`
- **`api_request`:** any other endpoint (GET only and allowlisted paths for agents), e.g. `/pixel/list/`

Lists are paged: pass `next_cursor` back as `cursor` (sent as `page`; `limit` is `page_size`, up to 1000, 100 for
forms). List arguments (`fields`, `dimensions`, `metrics`, `advertiser_ids`) are lists; they are sent as JSON
arrays. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A TikTok for Business developer app approved for the Marketing API, and an access token for your advertisers

## Installation
```bash
graphrt plugin install ./tiktok-ads
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `TIKTOK_ADS_ACCESS_TOKEN` | yes | Marketing API access token, sent as the `Access-Token` header |
| `TIKTOK_ADS_TOOL_ALLOW_WRITES` | no | `1` lets agent tools enable/disable campaigns, ad groups and ads and change budgets; see the two rows below |
| `TIKTOK_ADS_TOOL_ADVERTISER_IDS` | for any agent write | Comma-separated advertiser ids agents may change. Unset refuses every agent write |
| `TIKTOK_ADS_TOOL_MAX_BUDGET` | for agent budget changes and ENABLE | Highest total budget per agent call, and highest budget an object may have to be enabled by an agent, in the **account currency's units** (not cents). Unset or `0` refuses every agent budget change and ENABLE |
| `TIKTOK_ADS_TOOL_ALLOW_LEADS` | no | `1` lets agent tools read leads (personal data): `get_lead`, `create_lead_download_task`, `download_leads` |
| `TIKTOK_ADS_LEADS_DIR` | for `download_leads` | Absolute directory where lead files are saved |
| `TIKTOK_ADS_TOOL_API_EXTRA_PATHS` | no | More GET paths agents may reach with `api_request`, comma-separated, `*` = one segment |

This is a different token from `tiktok-api`'s `TIKTOK_ACCESS_TOKEN` (Login Kit / Content Posting) and
`TIKTOK_BUSINESS_ACCESS_TOKEN` (Business accounts): it is the advertiser authorization token of a Marketing API app.

**Currency units.** TikTok budgets are decimals in the currency's main unit: `50.5` is USD 50.50, `500000` is
IDR 500,000 (IDR, JPY and KRW take whole numbers). The cap is compared with the value as sent; for
`set_ad_group_budgets` it caps the sum of every `budget` and `scheduled_budget` in the call. TikTok also enforces
minimums (e.g. USD 50 a day for campaigns, USD 20 for ad groups; see
[Currency](https://business-api.tiktok.com/portal/docs?id=1737585839634433)).

**Getting a token:**
1. Register at the [TikTok API for Business portal](https://business-api.tiktok.com/portal), create a developer
   app and request the scopes you need (Ad Account Management, Ads Management, Reporting, Lead/Instant Form
   access). TikTok reviews the app.
2. Send an advertiser the app's authorization URL; after they approve, exchange the `auth_code` at
   `/oauth2/access_token/` (with your app id and secret, outside this plugin). The response lists the authorized
   `advertiser_ids`. Marketing API tokens do not expire until the advertiser revokes them.
3. Lead downloads need an ad account admin. EEA, Swiss and UK leads need `lead_region: eu`, US leads `lead_region:
   us`; without it only leads from other regions are returned.

The OAuth endpoints (`/oauth2/...`) take the app secret, so this plugin offers no operation for them and agents
cannot reach them with `api_request`.

**Pricing:** API calls are free. Enabling ads and raising budgets spends money on the ad account.

## Quick Start
```bash
TIKTOK_ADS_ACCESS_TOKEN=... graphrt run tiktok-ads/example.yaml --plugins .
```
Set `advertiser_id` in the example to one of your ad accounts. It reads the account and its campaign spend per day.

## Usage
```yaml
- id: report
  type: tiktok-ads.get_report
  advertiser_id: "7000000000000000001"
  data_level: AUCTION_AD
  dimensions: [ad_id]
  metrics: [spend, impressions, clicks, conversion]
  start_date: "2026-11-01"
  end_date: "2026-11-18"
- id: pause
  type: tiktok-ads.set_campaign_status
  advertiser_id: "7000000000000000001"
  campaign_ids: ["1800000000000000001"]
  operation_status: DISABLE
- id: budget
  type: tiktok-ads.set_campaign_budget
  advertiser_id: "7000000000000000001"
  campaign_id: "1800000000000000001"
  budget: 75.5        # USD 75.50 on a USD account
```

## Agent policy
- **Reads** are agent tools. `access_token`, `refresh_token` and `secret` fields are removed from tool results.
- **Leads** (`TIKTOK_ADS_TOOL_ALLOW_LEADS=1`): `get_lead`, `create_lead_download_task`, `download_leads`.
  `list_lead_forms` and `get_lead_form_fields` (no answers) are normal reads.
- **Account scoping** (every agent write): `advertiser_id` must be in `TIKTOK_ADS_TOOL_ADVERTISER_IDS`, and every
  target campaign, ad group or ad is looked up under that advertiser first; one that is not found, or a failed
  lookup, refuses the call.
- **Disabling** (`TIKTOK_ADS_TOOL_ALLOW_WRITES=1` + account scoping): DISABLE. DELETE is irreversible, so it is only
  available through the node-only `delete_*` operations.
- **Enabling** (also `TIKTOK_ADS_TOOL_MAX_BUDGET`): ENABLE starts spending the budget an object already has. Each
  target's effective budget is read (a campaign's own; an ad group's own, else its campaign's under campaign budget
  optimization; an ad's ad group's) and the call is refused when one is over the cap, has no finite budget
  (`BUDGET_MODE_INFINITE`), or cannot be read.
- **Budgets** (`TIKTOK_ADS_TOOL_ALLOW_WRITES=1` + account scoping **and** `TIKTOK_ADS_TOOL_MAX_BUDGET`): amounts over
  the cap are refused before anything is sent. For every caller (nodes too), budget items must be exactly
  `{"adgroup_id": "...", "budget": <number>}` (or `scheduled_budget`), and amounts must be positive numbers; strings
  such as `"0x10"` are refused.
- **What the cap is not:** it is checked per call and per object, not as a total across calls, objects or days: an
  agent can still enable several objects, each within the cap. TikTok can also spend somewhat more than a daily
  budget on a given day.
- **Node only:** `create_campaign`, `create_ad_group`, `create_ad`, `delete_campaigns`, `delete_ad_groups`,
  `delete_ads`.
- `api_request` is GET-only for agents and limited to `/advertiser/info/`, `/campaign/get/`, `/adgroup/get/`,
  `/ad/get/`, `/report/integrated/get/`, `/page/get/`, `/lead/field/get/`, `/pixel/list/` and `/identity/get/`.

## Errors
TikTok answers most failures with HTTP 200 and `code != 0`; the plugin turns them into errors with the message and
code, e.g. `Access token is incorrect or has been revoked. (40105)`. 40101–40108 and 40113 are `auth_error`; 40001,
40118, 40125 and 41000 `permission_denied`; 40000, 40002, 40006 and 40011 `invalid_input`; 40007 and 40300
`not_found`; 40100, 40016, 40132 and 40133 (rate limits) `rate_limited`. Writes are never retried after a 5xx or
network failure: the error says the outcome is unknown and how to check.

## Known limits
- `get_lead` returns one lead per call (TikTok's docs do not say which one when a form has several); use the lead
  download task for all leads.
- `download_leads` only saves non-JSON answers: a JSON answer (task not ready, bad token) is raised as the mapped
  error and nothing is saved, also when TikTok labels it `text/csv` or sends no content type (the start of
  the body is checked).

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/agent-policy.test.mjs` covers the budget caps,
opt-ins, the `api_request` allowlist, token stripping and the body error codes. Verified live only with an invalid
token (`auth_error`); not tested against a real ad account.

## License
Apache-2.0
