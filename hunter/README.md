# hunter

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Hunter.io API v2](https://hunter.io/api-documentation/v2):
find and verify professional email addresses, enrich people and companies, discover companies, and keep leads and
leads lists.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The
`api_request` tool path allowlist is [`lib/api-request-allowlist.mjs`](lib/api-request-allowlist.mjs), copied
unchanged from `brevo`.

## Features
- **Finding emails (credits):** `domain_search` (addresses at a domain or company, filtered by type, seniority,
  department, verification status), `find_email` (a person's address), `verify_email` (deliverability)
- **Enrichment (credits):** `enrich_person` (by email or LinkedIn handle), `enrich_company` (by domain)
- **Free:** `count_emails`, `discover_companies` (natural-language query or filters), `get_account`
- **Leads:** `list_leads` (filters, `limit`/`cursor` offset paging, up to 1,000 per page), `get_lead`,
  `create_lead`, `upsert_lead` (matches on email), `update_lead`, `delete_lead` (node only)
- **Leads lists:** `list_leads_lists`, `get_leads_list`, `create_leads_list`, `update_leads_list`,
  `delete_leads_list` (node only)
- **`api_request`:** any other endpoint (GET only for agents, and only the free read paths below)

Responses keep Hunter's `{data, meta}` envelope, except the paged lists, whose `data` is the array of leads or
lists. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Hunter account (the free plan includes a small monthly quota)

## Installation
```bash
graphrt plugin install ./hunter
```

## Configuration
| Env var | Purpose |
|---|---|
| `HUNTER_API_KEY` | API key, sent in the `X-API-KEY` header (never in the URL) |
| `HUNTER_TOOL_ALLOW_LEAD_WRITES` | `1` lets agent tools create and update leads and leads lists |

### Getting the credentials
Hunter dashboard → **API** (https://hunter.io/api-keys) → copy or create a key. Hunter's documented
`test-api-key` returns dummy data for Domain Search, Email Finder and Email Verifier.

**Pricing / credits:** every plan has a monthly quota; `get_account` shows `requests.*.used`, `available` and
`remaining` and the `reset_date`.
- Plans with one credit pool: a search (Domain Search, Email Finder) costs 1 credit, a verification 0.5 credit,
  an enrichment 0.2 credit (and needs at least 1 credit left).
- Plans with separate quotas: Domain Search, Email Finder and enrichment use **searches**, Email Verifier uses
  **verifications**.
- Hunter charges only when there is a result (a Domain Search returning at least one email, an Email Finder that
  finds an address), and a repeated search in the same billing period is free; the `X-Credits-Used` response header
  shows the cost of a call.
- Free: Email Count, Discover, account, leads and leads lists.

## Quick Start
```bash
HUNTER_API_KEY=... graphrt run hunter/example.yaml --plugins .
```

## Usage
```yaml
- id: people
  type: hunter.domain_search
  domain: "{{#start.domain#}}"
  email_type: personal
  seniority: [senior, executive]
  limit: 10
- id: check
  type: hunter.verify_email
  email: "{{#start.email#}}"
- id: save
  type: hunter.create_lead
  email: "{{#start.email#}}"
  first_name: "{{#start.first_name#}}"
  job_position: Founder
  leads_list_id: 7
```

- `job_position` and `email_type` are sent as Hunter's `position` and `type` (graphrt reserves those node keys).
- `verify_email` can take up to 20 seconds. When Hunter has not finished, it answers HTTP 202, and the plugin
  returns `{"status": "pending", "hint": "...call verify_email again...", "response": ...}` instead of the usual
  `{data, meta}`. Call it again with the same email a few seconds later; Hunter counts the repeat as the same
  request.

## Agent policy
- Searches, verifications and enrichments are tools, but they spend credits: they are `write: "unsafe"`, so a
  timeout or 5xx is never retried, and the error says to check `get_account` first.
- Lead and leads-list writes (`create_lead`, `upsert_lead`, `update_lead`, `create_leads_list`,
  `update_leads_list`) are tools only with `HUNTER_TOOL_ALLOW_LEAD_WRITES=1`.
- `delete_lead` and `delete_leads_list` are node only.
- `api_request` as a tool is GET-only and limited to the free paths `/account`, `/email-count`, `/leads`,
  `/leads_lists` (and its alias `/leads-lists`); paths are compared case-insensitively after repeated
  percent-decoding, and dot or encoded-separator segments are refused. That keeps the billed GET endpoints away
  from it (as a GET, the layer would retry them).
- Results hold personal data (names, emails, phone numbers, LinkedIn). Handle them under your privacy obligations
  (GDPR, Indonesia's UU PDP); Hunter returns 451 `claimed_email` for people who opted out.

## Errors
Errors are `{"errors": [{"id", "code", "details"}]}`; the message is `details (id)`.
- 401 → `auth_error` (missing or invalid key)
- 400 `wrong_params`, `pagination_error`, `invalid_*` → `invalid_input`
- 403 → `rate_limited` (Hunter uses 403 for its per-second/minute rate limits), except `no_*_access` →
  `permission_denied`
- 429 → `permission_denied`, `retryable: false`, never retried by the client. Hunter means the plan's usage limit
  is reached; waiting until `reset_date` or upgrading helps, retrying does not. The shared client retries only
  `rate_limited` errors, and a 429 is mapped away from that kind.
- 451 `claimed_email` → `permission_denied`; 404 → `not_found`

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for header auth, no retries on credit calls, the lead opt-in, the api_request
allowlist and error mapping. Verified live only with an invalid key (`auth_error`).

## License
Apache-2.0
