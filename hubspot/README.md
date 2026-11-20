# hubspot

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [HubSpot CRM API](https://developers.hubspot.com/docs/api-reference/latest/overview.md).
It works with contacts, companies, deals and tickets, and with other standard objects (notes, tasks, calls,
meetings, emails, products, line items, quotes, leads). You can list, get, search, create and update records,
associate them, and add notes to their timelines. It also reads properties, pipelines and owners.

The plugin uses HubSpot's date-versioned API **2026-09** (`/crm/objects/2026-09/...`). These endpoints have the
same contracts as CRM v3/v4, and HubSpot is retiring v1 to v4. It is built with the declarative REST layer
([docs/declarative-plugins.md](../docs/declarative-plugins.md)).

## Features
- **Records** (`object_type`: contacts, companies, deals, tickets, notes, tasks, calls, meetings, emails,
  products, line_items, quotes, leads):
  - `list_objects`, `get_object` (also by a unique property, such as `id_property: email`)
  - `search_objects`: filter groups, a text query and one sort; up to 200 per page and 10,000 per search
  - `create_object` (optionally with associations) and `update_object`
  - `archive_object`: moves the record to the recycle bin, restorable for 90 days (node only)
- **Associations:**
  - `list_associations`: labels included
  - `associate_objects`: the default association
  - `remove_association` (node only)
- **Notes:** `create_note` takes text, a timestamp (default: now), an owner and plain lists of
  contact/company/deal/ticket ids. The plugin builds HubSpot's association array, using type ids 202, 190, 214
  and 228.
- **Schema:**
  - `list_properties`: internal names and dropdown options
  - `list_pipelines`: deal or ticket stages
  - `list_owners`
  - `get_account_details`: portal id, time zone, currency
- **`api_request`:** any other endpoint. Agents get GET only, on CRM paths only (see Agent policy).

Paginated operations take `limit` and `cursor` (HubSpot's `after`) and return `next_cursor`. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A HubSpot account where you can create a private app (Super Admin)

## Installation
```bash
graphrt plugin install ./hubspot
```

## Configuration
| Env var | Purpose |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Private app access token (`pat-...`), sent as a Bearer token |

A node can pass `access_token` instead (for example an OAuth access token from your own app). This needs
`--trust-plugin hubspot`. Agent tools can never pass one.

### Getting the token
1. In HubSpot, go to **Settings → Integrations → Private Apps → Create a private app** (in newer accounts:
   **Development → Legacy apps → Create → Private**).
2. Under **Scopes**, add only what your workflows need, for example:
   - `crm.objects.contacts.read` / `.write`
   - `crm.objects.companies.read` / `.write`
   - `crm.objects.deals.read` / `.write`
   - `tickets` (or `crm.objects.tickets.read` / `.write` where they are offered)
   - `crm.objects.owners.read`
   - for `list_properties`, the object's read scope is enough
3. Create the app and copy its access token into `HUBSPOT_ACCESS_TOKEN`.

A call without a needed scope fails with `permission_denied` (`MISSING_SCOPES`).

**Pricing and limits:** the API is free with every HubSpot plan; the CRM features you use depend on your
subscription. Private apps are limited per account:
- 100 requests per 10 seconds (Free/Starter), 190 per 10 seconds (Professional/Enterprise)
- a daily cap between 250,000 and 1,000,000 requests
- search endpoints: 5 requests per second

## Quick Start
```bash
HUBSPOT_ACCESS_TOKEN=pat-... graphrt run hubspot/example.yaml --plugins .
```
The example searches for the five newest contacts in lifecycle stage `lead`.

## Usage
```yaml
- id: find
  type: hubspot.get_object
  object_type: contacts
  object_id: "{{#start.email#}}"
  id_property: email
  properties: [firstname, lifecyclestage, hubspot_owner_id]
- id: company
  type: hubspot.create_object
  object_type: companies
  properties: { name: Acme, domain: acme.example }
- id: link
  type: hubspot.associate_objects
  from_object_type: contacts
  from_object_id: "{{#find.data.id#}}"
  to_object_type: companies
  to_object_id: "{{#company.data.id#}}"
- id: note
  type: hubspot.create_note
  body: "Demo booked for next Tuesday"
  contact_ids: ["{{#find.data.id#}}"]
  company_ids: ["{{#company.data.id#}}"]
- id: stage
  type: hubspot.update_object
  object_type: deals
  object_id: "{{#start.deal_id#}}"
  properties: { dealstage: closedwon }
```
Property values use internal names (see `list_properties`). Dropdown values use option values, not labels.
`dealstage` and `hs_pipeline_stage` take stage ids from `list_pipelines`.

## Agent policy
- **Tools:** reads, `search_objects`, `create_object`, `update_object`, `associate_objects` and `create_note`.
  None of these send anything to anyone.
- **Node only:** `archive_object` and `remove_association` (destructive).
- **`api_request` for agents:** GET only, and only paths under `/crm/objects`, `/crm/properties`,
  `/crm/pipelines`, `/crm/owners`, `/crm/associations`, their `/crm/v3/...` and `/crm/v4/...` equivalents
  and `/account-info/.../details`.
  Other GET endpoints return SMTP API tokens, app and webhook settings and similar configuration. Paths are
  decoded repeatedly before the check (`%252e` is `.`), and `.`, `..`, empty segments and encoded slashes or
  backslashes are refused. Nodes are not limited.

## Per-user tokens (multi-user agents)

Set `HUBSPOT_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin hubspot`):

```yaml
tools: [hubspot/list_objects]
tool_context:
  hubspot:
    access_token: "{{#start.hubspot_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an OAuth access token (or personal API token) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `HUBSPOT_ACCESS_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
HubSpot errors are `{"status": "error", "message", "correlationId", "category", "context"?}`. The plugin maps
`category`:

| `category` | Error kind |
|---|---|
| `INVALID_AUTHENTICATION`, `EXPIRED_AUTHENTICATION` | `auth_error` |
| `MISSING_SCOPES` | `permission_denied` |
| `OBJECT_NOT_FOUND` | `not_found` |
| `VALIDATION_ERROR` | `invalid_input` |
| `RATE_LIMITS`, or a 429 status | `rate_limited` |

A 409 `CONFLICT`, for example "Contact already exists. Existing ID: 123", keeps HubSpot's message.

`create_object` and `create_note` are never retried after an unknown outcome. Search for the record before
creating it again. Unknown `object_type` values, empty ids and unparseable note timestamps are refused before
any request.

## Testing
```bash
npm test          # from the repo root
```
The tests cover:
- the generated contract suite
- note argument building
- the `api_request` path allowlist (traversal and encoded dots)
- the error-category mapping
- the agent policy

Verified live only with an invalid token, which gives `auth_error`: `Authentication credentials not found.
(INVALID_AUTHENTICATION)`.

## License
Apache-2.0
