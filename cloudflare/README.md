# cloudflare

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Cloudflare API v4](https://developers.cloudflare.com/api/).
It reads accounts and zones, lists and changes DNS records, purges the cache from workflow nodes, and lists Workers
with their settings and deployments. It is built with the declarative REST layer ([`definition.mjs`](definition.mjs)).

## Features
- **Token, accounts, zones:** `verify_token` (user tokens), `verify_account_token` (account-owned tokens, which
  `verify_token` rejects), `list_accounts`, `list_zones`, `get_zone`
- **DNS:** `list_dns_records`, `get_dns_record`, `create_dns_record`, `update_dns_record`, `delete_dns_record`
  (node only)
- **Cache:** `purge_cache` (node only): everything, or by URLs, cache tags, hostnames or prefixes
- **Workers:** `list_workers`, `get_worker_settings` (bindings by name and type; secret values are never returned),
  `list_worker_deployments`
- **`api_request`:** any other v4 endpoint, e.g. `/zones/<zone_id>/settings` (agents: GET only, on an allowlist)

Lists page by page number (`result_info.total_pages`): pass `next_cursor` back as `cursor`; `limit` is `per_page`
(zones and accounts: 5 to 50; an agent asking for fewer than 5 gets 5). Results are Cloudflare's `result`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api.cloudflare.com`

## Installation
```bash
graphrt plugin install ./cloudflare
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | API token (`Authorization: Bearer`). Global API keys are not supported. |
| `CLOUDFLARE_TOOL_ALLOW_WRITE` | no | `1` lets agent tools create and update DNS records named in the next variable |
| `CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES` | for tool DNS writes | DNS names agents may create/update: `api.example.com, *.preview.example.com` |
| `CLOUDFLARE_TOOL_API_EXTRA_PATHS` | no | More read paths for agent `api_request`, comma-separated, `*` = one segment |

**Getting a token:** Cloudflare dashboard → My Profile → API Tokens → Create Token. Grant only what you use and limit
it to specific zones/accounts:
- Zone → Zone: Read; Zone → DNS: Read (Edit for DNS writes); Zone → Cache Purge: Purge (for `purge_cache`)
- Account → Workers Scripts: Read; Account → Account Settings: Read (for `list_accounts`)

**Rate limits:** 1,200 requests per 5 minutes per user (across tokens), plus per-endpoint limits; cache purges have
their own plan-based limits. 429 is `rate_limited`.

## Quick Start
```bash
CLOUDFLARE_API_TOKEN=... graphrt run cloudflare/example.yaml --plugins .
```
The example verifies the token and lists DNS records of the first zone.

## Usage
```yaml
- id: zone
  type: cloudflare.list_zones
  name: example.com
- id: record
  type: cloudflare.list_dns_records
  zone_id: "{{#zone.data.0.id#}}"
  record_type: A
  name: api.example.com
- id: repoint
  type: cloudflare.update_dns_record
  zone_id: "{{#zone.data.0.id#}}"
  record_id: "{{#record.data.0.id#}}"
  content: 198.51.100.7
```

## Agent policy
- **Reads** are agent tools.
- **DNS writes from agents are off by default.** `create_dns_record` and `update_dns_record` work as tools only with
  `CLOUDFLARE_TOOL_ALLOW_WRITE=1` **and** for names listed in `CLOUDFLARE_TOOL_DNS_ALLOWED_NAMES` (comma-separated
  FQDNs, exact like `api.example.com` or a wildcard like `*.preview.example.com`, which matches any name below
  `preview.example.com` but not that name itself). A tool update first reads the record and refuses unless its
  current name, and any new `name`, are listed. Why: whoever controls a DNS record controls where its traffic goes;
  an agent that can repoint `www`, `mail` or an `MX`/`TXT` record can hijack the site, intercept email or pass domain
  validation for a certificate. List only throwaway names (preview hosts), and scope the token to those zones.
- **Node only:** `delete_dns_record`, `purge_cache` (a full purge sends all traffic to your origin).
- **`api_request`** is GET-only for agents and reaches only an allowlist: user, accounts, zones, zone settings, DNS
  records (and export), page rules, rulesets, custom hostnames, certificate packs, Worker routes, and Worker scripts'
  settings, deployments, versions and schedules. The path is decoded and `.`/`..` resolved first. Tokens of any kind
  (API, tunnel, WARP connector, Access service tokens), Worker source (`content`) and secrets, KV values, key
  material and everything else are refused. `CLOUDFLARE_TOOL_API_EXTRA_PATHS` adds paths (comma-separated,
  `*` = one segment), never the refused kinds.
- `create_dns_record` is never retried after an unknown outcome; the error says how to check.

## Errors
Cloudflare's `errors[0].message` (or its `error_chain`) and code are shown, e.g. `Invalid API Token (1000)`. Codes
1000, 9109 and 10000 (bad or unauthorized token) and 6003 (malformed auth header) are `auth_error`; otherwise 403 is
`permission_denied` (token lacks a permission or zone), 404 `not_found`, 400 `invalid_input` (e.g. a record that
already exists), 429 `rate_limited`. A 200 with `success: false` is also an error.

## Testing
```bash
npm test          # from the repo root
```
Contract suite for every operation, plus page paging, error mapping (codes and error chains), the DNS name allowlist
(including the update pre-check), the `api_request` allowlist with traversal and encoding bypasses, and the page-size
minimum.
Live check: the example with an invalid token gives `auth_error: API error 401: Invalid API Token (1000)`.

## License
Apache-2.0
