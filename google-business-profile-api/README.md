# google-business-profile-api

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Google Business Profile APIs**
(formerly Google My Business). It manages the Maps and Search listings you own or manage: accounts and locations,
description, phones and opening hours, reviews and replies, posts, and daily performance metrics. It pairs with
`google-maps-scraper`, which finds listings you don't own. Every operation is a workflow node and an agent tool.

## Features
- **Accounts and locations:** list accounts, list and get locations (`readMask`), update description, phones,
  regular hours and special (holiday) hours (`updateMask` built from the fields you pass)
- **Reviews:** list (with average rating and total count), get, reply or edit the reply, delete the reply
- **Posts:** list, create STANDARD / EVENT / OFFER posts with a button and a photo URL, delete
- **Performance:** daily impressions (Maps/Search, desktop/mobile), calls, website clicks, directions, messages,
  bookings and menu clicks, with per-metric totals
- **`api_request`:** any other endpoint on the four Business Profile hosts, chosen with `host`
- **Auth:** OAuth refresh token, service account key file, or a ready access token; tokens are fetched and cached
  by the plugin, one refresh serves all hosts
- Creating a post is never retried after an unknown outcome; the error says how to check. `update_location` is
  safe to resend, so its failures are retryable. A delete that is retried and then gets 404 returns
  `{deleted: true, already_absent: true}`

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- **Approved API access.** The Business Profile APIs are not open by default: request access with Google's
  [Business Profile API access form](https://developers.google.com/my-business/content/prereqs). Until Google
  approves the project, its quota is 0 requests per minute and every call fails with `rate_limited`.
- In the Google Cloud project, enable: My Business Account Management API, My Business Business Information API,
  Google My Business API (v4: reviews, posts) and Business Profile Performance API
- An OAuth client and a refresh token for a Google account that owns or manages the profiles, with scope
  `https://www.googleapis.com/auth/business.manage`
- Locations must be verified for reviews and posts

## Installation
```bash
graphrt plugin install ./google-business-profile-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
Set **one** of these credential options.

| Env var | Description |
|---------|-------------|
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token (authorize with `access_type=offline` and the `business.manage` scope) |
| `GOOGLE_CLIENT_ID` | OAuth client id that issued the refresh token |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Path** to a service account JSON key file |
| `GOOGLE_ACCESS_TOKEN` | A ready OAuth access token (expires after about an hour) |

- **Refresh trio (recommended):** the plugin exchanges the refresh token at `https://oauth2.googleapis.com/token`,
  caches the access token until a minute before it expires, and refreshes once on a 401.
- **Service account:** supported (RS256 JWT signed with `node:crypto`, exchanged at
  `https://oauth2.googleapis.com/token`; the private key is never logged or returned), but Business Profile is
  normally managed by user accounts. A service account only sees profiles it was added to as a manager.
- **Precedence:** refresh trio, then service account. `GOOGLE_ACCESS_TOKEN` is used first when set, and a
  configured trio or service account takes over after a 401.
- A node can take `access_token` to use another account. That token is used as-is and is never refreshed. Pass it
  from a secret and trust the plugin (`--trust-plugin google-business-profile-api`).

The same variables configure the `google-sheets` plugin; a refresh token can carry both scopes.
graphrt starts plugins with a clean environment, and only these variables are passed through.

## Quick Start
```bash
export GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
graphrt run google-business-profile-api/example.yaml --plugins .
```

## Usage
```yaml
- id: reviews
  type: google-business-profile-api.list_reviews
  account_id: "123456789"
  location_id: "987654321"
  limit: 20
- id: reply
  type: google-business-profile-api.reply_to_review
  account_id: "123456789"
  location_id: "987654321"
  review_id: "{{#start.review_id#}}"
  comment: "Terima kasih atas ulasannya!"
```
- **Ids:** `account_id` comes from `list_accounts` (`accounts/123` or `123`), `location_id` from `list_locations`
  (`locations/456` or `456`). Full resource names work too: `review_id: "accounts/1/locations/2/reviews/X"` uses
  `X`. Reviews and posts need both ids.
- **All locations:** `list_locations` accepts `account_id: "-"` (`accounts/-`), which the
  [accounts.locations.list reference](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list)
  documents as the wildcard for the authenticated user: it covers directly and indirectly owned locations.
- **Hours:** times are `HH:MM` (00:00 to 24:00), dates `YYYY-MM-DD`. `regular_hours` and `special_hours` replace
  the whole list. A period that crosses midnight ends on `close_day`; without `close_day`, a `close_time` before
  `open_time` (`22:00` to `02:00`) closes on the next day.
- **Posts:** STANDARD needs `summary`. EVENT and OFFER need `event_title`, `event_start` and `event_end`
  (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, a time on both or on neither; the end must be after the start). Buttons other than CALL need `call_to_action_url`. `media_url` must be a
  public http(s) URL that Google fetches.
- **Metrics:** `get_daily_metrics` returns `{metric, total, values: [{date, value}]}` per metric; days without a
  value count as 0. `metrics` takes the non-deprecated values of the
  [DailyMetric enum](https://developers.google.com/my-business/reference/performance/rest/v1/DailyMetric)
  (default: all of them). `BUSINESS_CONVERSATIONS` and `BUSINESS_FOOD_ORDERS` are deprecated there and refused.
- **`api_request`:** `host` is one of `account_management` (`mybusinessaccountmanagement.googleapis.com/v1`),
  `business_information` (`mybusinessbusinessinformation.googleapis.com/v1`), `my_business_v4`
  (`mybusiness.googleapis.com/v4`, default) or `performance` (`businessprofileperformance.googleapis.com/v1`).
  `path` is relative to that base, e.g. `/categories` on `business_information`.
- **Polling:** graphrt plugins can't receive webhooks. To react to new reviews, run a workflow on a schedule.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments or ids, HTTP 400 (`INVALID_ARGUMENT`, `FAILED_PRECONDITION`, e.g. an unverified location) |
| `auth_error` | Missing, invalid or expired credentials, a rejected refresh token or service account key |
| `permission_denied` | The account doesn't manage the location, an API is not enabled, or Business Profile is off in the Workspace |
| `not_found` | Unknown account, location, review or post |
| `rate_limited` | `RESOURCE_EXHAUSTED` / 429 (retried); 0 quota means API access is not approved yet |
| `api_error`, `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it. `lib/google-auth.mjs`,
`lib/google-token-endpoint.mjs`, `lib/service-account.mjs` and `lib/google-errors.mjs` are kept identical to the
copies in `google-sheets/`.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `list_accounts` parameter `type` is now `account_type` (still sent as the API `filter=type=...`). graphrt takes `type` from every workflow node, so the old name could never be set from a node; tool calls that passed `type` must use `account_type`.

## License
Apache-2.0
