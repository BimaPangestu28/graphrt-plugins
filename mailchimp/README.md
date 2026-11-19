# mailchimp

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[Mailchimp Marketing API 3.0](https://mailchimp.com/developer/marketing/api/): audiences (lists), members and tags,
member search, campaigns and campaign reports. Member operations take an email address and compute Mailchimp's
subscriber hash (MD5 of the lower-cased address) for you.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs), plus
[`lib/subscriber-hash.mjs`](lib/subscriber-hash.mjs) for the email-to-hash wrappers. Transactional email
(Mailchimp Transactional, formerly Mandrill) is a separate API and is not covered.

## Features
- **Audiences:** `ping`, `list_audiences`, `get_audience`
- **Members:** `list_members`, `get_member`, `search_members`, `upsert_member` (add or update, PUT),
  `list_member_tags`, `update_member_tags`, `archive_member` (node only), `delete_member_permanently` (node only)
- **Campaigns:** `list_campaigns`, `get_campaign`, `get_campaign_content`, `send_campaign`, `schedule_campaign`,
  `unschedule_campaign` (the last three node only)
- **Reports:** `list_reports`, `get_report`
- **Webhooks (node only, their URLs often hold a secret):** `list_audience_webhooks`, `get_audience_webhook`,
  `list_batch_webhooks`
- **`api_request`:** any other endpoint, e.g. `/lists/<list_id>/merge-fields` (GET only for agents, and only an
  allowlist of read paths)

Lists use Mailchimp's `count`/`offset`: `limit` (default 50, max 1000) and `next_cursor` (the next offset, null
after `total_items`). `fields`/`exclude_fields` trim responses. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Mailchimp account with Marketing API access

## Installation
```bash
graphrt plugin install ./mailchimp
```

## Configuration
| Env var | Purpose |
|---|---|
| `MAILCHIMP_API_KEY` | API key (`<32 hex>-us21`); sent as HTTP Basic password |
| `MAILCHIMP_SERVER_PREFIX` | Optional data center, e.g. `us21`; overrides the key's suffix (needed when a node passes an OAuth `access_token`) |
| `MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES` | `1` lets agent tools use `upsert_member` and `update_member_tags` |

The API host is `https://<dc>.api.mailchimp.com/3.0`, where `<dc>` is the part of the key after the last `-`.
It must look like `us21` (letters then digits); anything else is refused before a request (`invalid_input`).

### Getting the credentials
Mailchimp: **Profile → Extras → API keys → Create A Key**. The key acts with the creating user's role, so a
Viewer user's key cannot write. For apps used by other accounts, use Mailchimp OAuth 2 and pass the token as the
node's `access_token` (with `MAILCHIMP_SERVER_PREFIX` from the token's metadata endpoint).

**Pricing / limits:** API access is free on every plan, but plans are billed by contact count: adding members can
move the account to a higher tier, and sends count against the plan's monthly email limit. Mailchimp allows 10
simultaneous connections per key (more returns 429 `TooManyRequests`).

## Quick Start
```bash
MAILCHIMP_API_KEY=...-us21 graphrt run mailchimp/example.yaml --plugins .
```

## Usage
```yaml
- id: lead
  type: mailchimp.upsert_member
  list_id: "{{#start.list_id#}}"
  email_address: "{{#start.email#}}"
  status_if_new: pending          # double opt-in: Mailchimp emails a confirmation link
  merge_fields: { FNAME: "{{#start.first_name#}}" }
  tags: [website-lead]
- id: tag
  type: mailchimp.update_member_tags
  list_id: "{{#start.list_id#}}"
  email: "{{#start.email#}}"
  tags: [{ name: vip, status: active }]
```

- Use `subscribed` only for people who gave consent; `pending` sends Mailchimp's double opt-in email.
- `schedule_campaign` needs a quarter-hour UTC time (`:00`, `:15`, `:30`, `:45`).

## Agent policy
- Reads (audiences, members, search, tags, campaigns, content, reports) are tools.
- `upsert_member` and `update_member_tags` need `MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES=1` as tools: adding a member
  or a tag can start automations that email the person, and contacts are billed.
- Node only: `send_campaign`, `schedule_campaign`, `unschedule_campaign` (mass sends), `archive_member`,
  `delete_member_permanently` (irreversible) and the webhook reads.
- `api_request` as a tool is GET-only and limited to paths under `/ping`, `/lists`, `/search-members`,
  `/campaigns`, `/campaign-folders`, `/reports`, `/templates` and `/template-folders`, without
  `/lists/<id>/webhooks`. Paths are percent-decoded repeatedly before the check, and `.`, `..`, empty segments and
  encoded slashes or backslashes are refused, so `/lists/x/members/%2e%2e/webhooks` cannot reach a webhook config.
- A `subscriber_hash` given together with `email` or `email_address` must be the hash of that address.

## Errors
Mailchimp errors are `application/problem+json` (`{type, title, status, detail, instance, errors?}`); the message
is `detail (title)`. `API Key Invalid` → `auth_error`; `Forbidden`, `User Disabled`, `Authorization Failure` →
`permission_denied`; `Resource Not Found` → `not_found`; `Invalid Resource`, `Member Exists`, `Bad Request` →
`invalid_input`; `TooManyRequests`/429 → `rate_limited`. Sends and permanent deletes are never retried after an
unknown outcome (check `get_campaign` / `get_member` first); PUT upserts and tag updates are retried.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the subscriber hash, data center parsing and validation, the opt-in, node
only operations and the error mapping. Verified live only with an invalid key (`auth_error`).

## License
Apache-2.0
