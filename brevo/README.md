# brevo

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Brevo API v3](https://developers.brevo.com/reference)
(formerly Sendinblue): contacts and contact lists, transactional email (send, templates, delivery events) and
email campaigns.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The
transactional send checks its recipients in [`lib/transactional-email.mjs`](lib/transactional-email.mjs) with
[`lib/recipient-policy.mjs`](lib/recipient-policy.mjs) (copied unchanged from `gmail-api`).

## Features
- **Account:** `get_account` (plan and credits)
- **Contacts:** `list_contacts`, `get_contact` (by email, id, SMS or EXT_ID), `create_contact`, `update_contact`,
  `delete_contact` (node only)
- **Lists:** `list_lists`, `get_list`, `list_list_contacts`, `add_contacts_to_list`
- **Transactional email:** `send_transactional_email` (HTML/text or a template with params, attachments,
  scheduling), `list_email_templates`, `list_email_events` (requests, delivered, opened, bounces, ...)
- **Campaigns:** `list_email_campaigns`, `get_email_campaign`, `send_campaign_now` (node only)
- **Webhooks (node only, configs may hold credentials):** `list_webhooks`, `get_webhook`
- **`api_request`:** any other endpoint, e.g. `/senders` (GET only for agents, and only an allowlist of read paths)

Lists use Brevo's `limit`/`offset`: `next_cursor` is the next offset (null on a short page; `list_lists` uses the
total `count`). Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Brevo account; for transactional email an activated sender (verified domain or address)

## Installation
```bash
graphrt plugin install ./brevo
```

## Configuration
| Env var | Purpose |
|---|---|
| `BREVO_API_KEY` | API v3 key (`xkeysib-...`), sent in the `api-key` header |
| `BREVO_TOOL_ALLOW_SEND` | `1` lets agent tools use `send_transactional_email` |
| `BREVO_TOOL_RECIPIENT_ALLOWLIST` | Comma-separated addresses or `@domain`s agent tools may send to (to, cc and bcc) |
| `BREVO_TOOL_ALLOW_CONTACT_WRITES` | `1` lets agent tools create and update contacts and add them to lists |

### Getting the credentials
Brevo: **Settings → SMTP & API → API Keys → Generate a new API key**. Brevo can restrict keys to authorised IP
addresses (Security → Authorised IPs); if that is on, add the machine's IP or requests fail with 401. The SMTP key
is a different credential and does not work here.

**Pricing / limits:** transactional and marketing emails use the plan's email credits (free plan: 300 emails a
day); `get_account` shows what is left. A send that fails with `not_enough_credits` is mapped to
`permission_denied`. API rate limits depend on the plan and endpoint; 429 is `rate_limited`.

## Quick Start
```bash
BREVO_API_KEY=xkeysib-... graphrt run brevo/example.yaml --plugins .
```

## Usage
```yaml
- id: receipt
  type: brevo.send_transactional_email
  template_id: 12
  to: [{ email: "{{#start.email#}}", name: "{{#start.name#}}" }]
  params: { ORDER: "{{#start.order_id#}}" }
- id: lead
  type: brevo.create_contact
  email: "{{#start.email#}}"
  attributes: { FIRSTNAME: "{{#start.name#}}" }
  list_ids: [2]
  update_enabled: true
```

- Without `template_id`, `sender_email` (or `sender_id`), `subject` and `html_content` are required.
- Recipients are `{email, name?}` objects with plain addresses; display names in `email`, line breaks and
  missing addresses are refused before any request (`invalid_input`).
- Attribute names are upper case and must already exist in the account.

## Agent policy
- Reads (account, contacts, lists, templates, events, campaigns) are tools.
- `send_transactional_email` is a tool only with `BREVO_TOOL_ALLOW_SEND=1`. With `BREVO_TOOL_RECIPIENT_ALLOWLIST`
  set, every to/cc/bcc and `reply_to_email` address of a tool send must match it. **Without the allowlist, the
  opt-in lets agents send to any address.** Tool sends also refuse non-ASCII addresses (look-alike characters
  cannot match an allowed entry) and address headers in `email_headers` (To, Cc, Bcc, Reply-To, From, Sender, in
  any case). Nodes are not limited by these checks.
- `create_contact`, `update_contact` and `add_contacts_to_list` need `BREVO_TOOL_ALLOW_CONTACT_WRITES=1` as tools:
  adding a contact to a list can start automations that email them.
- Node only: `delete_contact`, `send_campaign_now` (a mass send) and the webhook reads.
- `api_request` as a tool is GET-only and limited to paths under `/account`, `/contacts`, `/senders`, `/domains`,
  `/smtp/templates`, `/smtp/statistics`, `/smtp/blockedContacts` and `/emailCampaigns`. Webhooks (credentials) and
  `/smtp/emails` (the content of sent emails, with reset links and codes) are refused. Paths are percent-decoded
  repeatedly before the check, and `.`, `..`, empty segments and encoded slashes or backslashes are refused.
- Batch sends (`messageVersions`, up to 2,000 recipients) are not offered as an operation; a workflow node can
  send them with `api_request` (POST `/smtp/email`), which agents cannot (GET only).

## Errors
Brevo errors are `{"code", "message"}`; the message is `message (code)`. `unauthorized` → `auth_error`;
`permission_denied`, `not_enough_credits`, `account_under_validation` → `permission_denied`;
`document_not_found` → `not_found`; `invalid_parameter`, `missing_parameter`, `out_of_range`,
`duplicate_parameter` → `invalid_input`; 429 → `rate_limited`. A failed send or `create_contact` is never retried
after an unknown outcome: check `list_email_events` (or `get_contact`) first. Brevo's idempotency key for sends
lives in the body's `headers.idempotencyKey`, not an HTTP header, so the plugin does not add one.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the opt-ins, the recipient allowlist on to/cc/bcc, address validation,
no retry of sends, node-only operations and the error mapping. Verified live only with an invalid key
(`auth_error`).

## License
Apache-2.0
