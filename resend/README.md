# resend

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Resend](https://resend.com/docs/api-reference/introduction)
email API. It sends email (html/text or a published template, now or scheduled), sends batches, reads sent emails,
reschedules or cancels scheduled ones and reads sending domains. Built with the
[declarative REST layer](../docs/declarative-plugins.md).

## Features
- **`send_email`:** from (display name allowed), to (max 50), cc, bcc, reply_to, subject, html and/or text or a
  `template_id` with `template_variables`, `scheduled_at` (ISO 8601 or "in 1 hour"), tags and `topic_id`. Every
  call carries a fresh `Idempotency-Key`, so a timeout or 5xx is retried without sending twice.
- **`send_batch_emails`** (node only): up to 100 emails in one call (no attachments or scheduling), with an
  `Idempotency-Key`.
- **Sent emails:** `list_emails` (cursor pagination), `get_email` (html/text, `last_event`), `reschedule_email`,
  `cancel_email` (node only).
- **Domains:** `list_domains`, `get_domain` (status and the DNS records to publish).
- **`api_request`:** any other endpoint (GET only for agents, and only under an allowlist of read paths).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Resend account with a verified sending domain (before that, Resend only delivers to your own address)

## Installation
```bash
graphrt plugin install ./resend
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | yes | API key (`re_...`) |
| `RESEND_TOOL_ALLOW_SEND` | no | `1` lets agent tools call `send_email` and `reschedule_email` |
| `RESEND_TOOL_RECIPIENT_ALLOWLIST` | no | Comma-separated addresses or `@domain`s agent tools may send to (to, cc and bcc) |

A node can pass `access_token` (an API key used as-is; needs `--trust-plugin resend`).

### Getting the credentials
1. Resend dashboard → **Domains → Add Domain**, publish the DNS records it shows (`get_domain` lists them too) and
   wait for `verified`.
2. **API Keys → Create API Key** with **Full access**. A **Sending access** key only works for `send_email` and
   `send_batch_emails`; reads then fail with `permission_denied` (`restricted_api_key`).

**Pricing / limits:** the free plan sends 3,000 emails a month and 100 a day; Pro is $20 a month for 50,000
emails, with optional pay-as-you-go overage (see <https://resend.com/pricing>). Every recipient of a sent email counts. The API allows 10 requests a
second per team by default (429 `rate_limit_exceeded`); daily and monthly quotas answer 429 too.

## Quick Start
```bash
RESEND_API_KEY=re_... graphrt run resend/example.yaml --plugins . --trust-plugin resend
```
The example lists your domains and the latest sent emails.

## Usage
```yaml
- id: welcome
  type: resend.send_email
  from: "Acme <hello@example.com>"
  to: ["{{#start.email#}}"]
  subject: Welcome to Acme
  html: "<p>Hi {{#start.name#}}, thanks for signing up.</p>"
  tags: [{ name: category, value: welcome }]
- id: reminder
  type: resend.send_email
  from: "Acme <hello@example.com>"
  to: ["ada@example.com"]
  template_id: renewal-reminder
  template_variables: { PLAN: Pro }
  scheduled_at: "in 3 days"
```
Recipient addresses must be plain (`ada@example.com`); only `from` may carry a display name. `data` of
`send_email` is `{id}`: pass it to `get_email` to follow delivery (`last_event`).

## Agent policy
- Reads (emails, domains) are tools. **`get_email` as a tool omits `html` and `text`**: sent emails often hold
  password-reset links, one-time codes and login links. Recipients, subject and delivery status stay visible.
  Workflow nodes get the full email.
- `send_email` and `reschedule_email` are tools only with `RESEND_TOOL_ALLOW_SEND=1`. With
  `RESEND_TOOL_RECIPIENT_ALLOWLIST` set, tool `send_email` calls may only address listed recipients (to, cc, bcc and
  reply_to); nodes are not limited by it. **Without the allowlist, the opt-in lets agents send to any address.**
  Tool sends also refuse non-ASCII addresses, so look-alike characters cannot match an allowed entry.
- `send_batch_emails` (bulk, recipients not checked) and `cancel_email` are node only.
- `api_request` as a tool is GET-only and limited to paths under `/domains`, `/audiences`, `/contacts`,
  `/broadcasts`, `/templates`, `/topics` and `/segments`. Other GET endpoints list API keys and webhooks with their
  signing secrets, and `/emails` (including received emails) is left to `get_email`/`list_emails`. Paths are
  percent-decoded repeatedly before the check, and `.`, `..`, empty segments and encoded slashes or backslashes are
  refused.

## Errors
Resend errors are `{"statusCode", "name", "message"}`. `missing_api_key`, `suspended_api_key` and an invalid key
(Resend answers `400 validation_error "API key is invalid"` outside sending; the plugin reports it as `auth_error`)
→ `auth_error`; `restricted_api_key`, `invalid_permission` and 403s (e.g. unverified `from` domain) →
`permission_denied`; `not_found` → `not_found`; other `validation_error`s, `missing_required_field` and
`invalid_idempotent_request` → `invalid_input`; `rate_limit_exceeded` and the daily/monthly quotas →
`rate_limited`. A send that still fails after the retries names its Idempotency-Key: check `list_emails` before
sending again.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for address and sender checks, the recipient allowlist, Idempotency-Key
retries, the User-Agent header, the invalid-key mapping and the api_request path allowlist. Verified live only with
an invalid key (`auth_error: API error 400: API key is invalid (validation_error)`).

## License
Apache-2.0
