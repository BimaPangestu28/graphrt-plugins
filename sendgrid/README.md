# sendgrid

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Twilio SendGrid v3 Web API](https://www.twilio.com/docs/sendgrid/api-reference).
It sends email from simple fields or a dynamic template and reads templates, delivery stats, suppression lists and
unsubscribe groups. Built with the [declarative REST layer](../docs/declarative-plugins.md).

## Features
- **`send_mail`:** from/to/cc/bcc/reply_to, subject, text and/or html, or a `template_id` (`d-...`) with
  `dynamic_template_data`; categories, `send_at` (up to 72 h ahead), unsubscribe group (`asm_group_id`) and
  `sandbox_mode` (validate without delivering). The plugin builds SendGrid's `personalizations` body.
- **`send_mail_raw`** (node only): any full mail/send body (many personalizations, attachments, tracking settings).
- **Templates:** `list_templates` (dynamic by default, paginated), `get_template` (all versions).
- **Stats:** `get_global_stats` per day, week or month.
- **Suppressions:** `list_bounces`, `list_blocks`, `list_spam_reports`, `list_invalid_emails`,
  `list_global_unsubscribes` (time range and address-prefix filters, offset pagination), `list_unsubscribe_groups`.
- **`api_request`:** any other v3 endpoint (GET only for agents, and only under an allowlist of read paths).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A SendGrid account with a verified Sender Identity or an authenticated domain

## Installation
```bash
graphrt plugin install ./sendgrid
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `SENDGRID_API_KEY` | yes | API key (`SG....`) |
| `SENDGRID_REGION` | no | `global` (default, `api.sendgrid.com`) or `eu` (`api.eu.sendgrid.com`, for EU regional subusers) |
| `SENDGRID_TOOL_ALLOW_SEND` | no | `1` lets agent tools call `send_mail` |
| `SENDGRID_TOOL_RECIPIENT_ALLOWLIST` | no | Comma-separated addresses or `@domain`s agent tools may send to (to, cc and bcc) |

A node can pass `access_token` (an API key used as-is; needs `--trust-plugin sendgrid`).

### Getting the credentials
1. SendGrid dashboard → **Settings → Sender Authentication**: authenticate your domain or verify a single sender.
   `from` must match one of them.
2. **Settings → API Keys → Create API Key**. Restricted access is enough: **Mail Send** (full), **Template Engine**,
   **Stats**, **Suppressions** and **Unsubscribe groups** (read). Set it as `SENDGRID_API_KEY`.
3. EU regional subusers (Pro plan or higher) set `SENDGRID_REGION=eu` and use a key of that subuser.

**Pricing / limits:** billed by the plan's monthly email volume (the free trial is limited; paid plans start with
Essentials). Every accepted recipient counts against the plan, sandbox-mode requests do not. One `send_mail` call
has one personalization with up to 1,000 cc and 1,000 bcc addresses. The v3 API rate limits per endpoint and
answers 429 with `X-RateLimit-Reset`.

## Quick Start
```bash
SENDGRID_API_KEY=SG.... graphrt run sendgrid/example.yaml --plugins . --trust-plugin sendgrid
```
The example lists your dynamic templates and the latest bounces.

## Usage
```yaml
- id: welcome
  type: sendgrid.send_mail
  from: hello@example.com
  from_name: Example
  to: ["{{#start.email#}}"]
  template_id: d-0123456789abcdef0123456789abcdef
  dynamic_template_data: { first_name: "{{#start.name#}}" }
- id: plain
  type: sendgrid.send_mail
  from: ops@example.com
  to: ["oncall@example.com"]
  subject: Nightly report
  text: All jobs passed.
```
Addresses must be plain (`ada@example.com`, no display names; use `from_name`). SendGrid accepts a send with 202 and
no body, so `data` is `null`; delivery shows up in Email Activity.

## Agent policy
- Reads (templates, stats, suppressions, groups) are tools.
- `send_mail` is a tool only with `SENDGRID_TOOL_ALLOW_SEND=1`. With `SENDGRID_TOOL_RECIPIENT_ALLOWLIST` set, tool
  calls may only address listed recipients (to, cc, bcc and reply_to); nodes are not limited by it. **Without the
  allowlist, the opt-in lets agents send to any address.** Tool sends also refuse non-ASCII addresses, so look-alike
  characters cannot match an allowed entry.
- `send_mail_raw` is node only (its recipients are not checked).
- `api_request` as a tool is GET-only and limited to paths under `/templates`, `/stats` (and `/geo|devices|clients|
  mailbox_providers|browsers/stats`), `/categories`, `/suppression`, `/asm`, `/messages`, `/verified_senders` and
  `/whitelabel/domains`: other GET endpoints list API keys, webhook settings, subusers and account details.
  Paths are percent-decoded repeatedly before the check, and `.`, `..`, empty segments and encoded slashes or
  backslashes are refused.

## Errors
SendGrid errors are `{"errors": [{"message", "field", "help"}]}`; the first message is reported. 401 →
`auth_error`, 403 (missing key scope) → `permission_denied`, 404 → `not_found`, 400/413 → `invalid_input` (e.g.
"The from address does not match a verified Sender Identity"), 429 → `rate_limited`. SendGrid has no idempotency
keys, so a failed send is never retried after an unknown outcome: check Email Activity before sending again.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the body builder, the recipient allowlist, the region switch and the
api_request path allowlist. Verified live only with an invalid key (`auth_error: API error 401: authorization
required`).

## License
Apache-2.0
