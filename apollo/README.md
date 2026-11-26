# apollo

**Status:** beta · **ToS risk:** medium. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Apollo.io API](https://docs.apollo.io/reference):
prospect search over Apollo's people and company database, person and company enrichment, and the contacts,
accounts and sequences of your Apollo workspace.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
- [`lib/sequence-id.mjs`](lib/sequence-id.mjs) fills the sequence id that the add-to-sequence endpoint wants twice.
- [`lib/api-request-allowlist.mjs`](lib/api-request-allowlist.mjs) is copied unchanged from `brevo`.

## Features
- **Prospecting:**
  - `search_people` (People API Search, `POST /mixed_people/api_search`: titles, seniorities, locations and
    employer filters; free);
  - `search_organizations` (`POST /mixed_companies/search`; 1 credit per page).
- **Enrichment (credits):**
  - `enrich_person` (`/people/match`);
  - `bulk_enrich_people` (up to 10, opt-in);
  - `enrich_organization` (`GET /organizations/enrich`);
  - `bulk_enrich_organizations` (up to 10, opt-in);
  - `enrich_person_with_callback` (phone reveal and waterfall, delivered to a `webhook_url`; node only).
- **Your workspace:**
  - contacts: `search_contacts`, `get_contact`, `create_contact`, `update_contact`, `list_contact_stages`;
  - accounts: `search_accounts`.
- **Sequences:** `search_sequences`, `list_email_accounts`, `add_contacts_to_sequence` (node only).
- **`get_api_usage`:** rate-limit usage per endpoint (needs a master key).
- **`api_request`:** any other endpoint (GET only for agents, and only the read paths below).

Search filters go in the query string as Apollo expects (`person_titles[]=...`). Searches page with
`limit` (`per_page`, max 100) and `cursor` (`page`). Apollo shows at most 50,000 records per search (500 pages): `next_cursor` stops after page 500 and a later cursor is refused.
Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An Apollo account. API access, Organization Search and enrichment need a paid plan; People API Search needs an
  account registered with a work email.

## Installation
```bash
graphrt plugin install ./apollo
```

## Configuration
| Env var | Purpose |
|---|---|
| `APOLLO_API_KEY` | API key, sent in the `x-api-key` header |
| `APOLLO_TOOL_ALLOW_BULK_ENRICHMENT` | `1` lets agent tools use `bulk_enrich_people` and `bulk_enrich_organizations` |
| `APOLLO_TOOL_ALLOW_CONTACT_WRITES` | `1` lets agent tools use `create_contact` and `update_contact` |

### Getting the credentials
Apollo → **Settings → Integrations → API → Create new key**.
- A scoped key works only for the endpoints you tick. Tick the paths this plugin uses, e.g.
  `api/v1/mixed_people/api_search`, `api/v1/people/match`, `api/v1/contacts/search`.
- A master key works everywhere. `get_api_usage` (and on some accounts the users list) needs one.
- A key without a path gets 403 `API_INACCESSIBLE` → `permission_denied`.
- Requests act as the workspace's longest-standing active admin.

**Pricing / credits:**
| Call | Cost |
|---|---|
| `search_people`, contacts, accounts, sequences | Free |
| `search_organizations` | 1 credit per page (up to 100 companies) |
| `enrich_person` | 1 credit when data is found (none for `match_confidence: none`), plus 8 for a mobile number (phone reveal) |
| `enrich_organization` | 1 credit per company |
| Bulk enrichment | The same per record |

Waterfall enrichment costs depend on your configured vendors. Rate limits are per endpoint and plan, e.g. Free
50/min, 200/h, 600/day; enrichment on paid plans 1,000/min. 429 → `rate_limited`.

## Quick Start
```bash
APOLLO_API_KEY=... graphrt run apollo/example.yaml --plugins .
```

## Usage
```yaml
- id: prospects
  type: apollo.search_people
  person_titles: [head of marketing]
  person_locations: [Jakarta, Indonesia]
  organization_num_employees_ranges: ["51,200"]
  limit: 25
- id: enrich
  type: apollo.enrich_person
  person_id: "{{#start.person_id#}}"
- id: save
  type: apollo.create_contact
  first_name: "{{#start.first_name#}}"
  last_name: "{{#start.last_name#}}"
  email: "{{#enrich.data.person.email#}}"
  job_title: "{{#enrich.data.person.title#}}"
  run_dedupe: true
```

`job_title`, `person_id` and `sequence_status` are sent as Apollo's `title`, `id` and `status` (graphrt reserves
those node keys).

## Agent policy
- **Credits:** `search_organizations`, `enrich_person` and `enrich_organization` are tools but spend credits.
  They are `write: "unsafe"`: never retried after a timeout or 5xx, and the error says to check credit usage first.
- **Opt-ins:** bulk enrichment needs `APOLLO_TOOL_ALLOW_BULK_ENRICHMENT=1`. Contact create/update needs
  `APOLLO_TOOL_ALLOW_CONTACT_WRITES=1`. `run_dedupe` overwrites the matching contact, and empty fields clear it.
- **`add_contacts_to_sequence` is node only, not opt-in.** Enrolling a contact makes Apollo email them, on the
  sequence's schedule and from your team's mailboxes. A recipient allowlist does not fit:
  - the call names contact ids, or whole lists via `label_names`, not addresses;
  - checking addresses would take extra lookups that can go stale before the add;
  - the emails go out later, outside the call.
- **Phone reveal and waterfall enrichment** deliver results to a `webhook_url`, so they are only on the node-only
  `enrich_person_with_callback`. No tool takes a callback URL.
- **`api_request`:** as a tool it is GET-only and limited to `/contacts`, `/contact_stages`, `/accounts`,
  `/account_stages`, `/email_accounts`, `/emailer_campaigns`, `/labels`, `/users` and `/auth/health`. Paths are
  compared after repeated percent-decoding; dot segments are refused. That keeps billed GETs such as
  `/organizations/enrich` away from it.
- **Personal data:** search and enrichment return names, titles, employers, LinkedIn URLs and (enrichment) work
  and personal emails and phone numbers. Treat results as personal data under GDPR / Indonesia's UU PDP. Store
  only what you need, and honour opt-outs. Apollo withholds personal emails for people in GDPR regions.

## Errors
Current errors carry `error_details: {code, message}` (the legacy root `error`/`error_code`/`message` fields are
still read):
- `AUTH.AUTHORIZATION.ENDPOINT_ACCESS_DENIED` → `permission_denied`
- `USAGE.RATE_LIMIT.*` → `rate_limited`
- `*.VALIDATION.*` and 422 → `invalid_input`
- 401 and `AUTH.AUTHENTICATION.API_KEY_INVALID` → `auth_error`

## Testing
```bash
npm test          # from the repo root
```
The generated contract suite runs, plus tests for:
- header auth and no retries on credit calls;
- the opt-ins and the bulk cap;
- the sequence id fill-in;
- the api_request allowlist;
- error mapping.

Verified live only with an invalid key (`auth_error`).

## License
Apache-2.0
