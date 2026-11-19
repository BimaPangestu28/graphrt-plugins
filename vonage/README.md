# vonage

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Vonage: send SMS and WhatsApp messages through the
[Messages API v1](https://developer.vonage.com/en/api/messages), look up numbers with
[Number Insight](https://developer.vonage.com/en/api/number-insight) and read the
[account balance](https://developer.vonage.com/en/api/account).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
[`lib/recipient-policy.mjs`](lib/recipient-policy.mjs) validates phone numbers (E.164) and holds the agent
recipient allowlist.

## Features
- **SMS:** `send_sms` (text, TTL, encoding)
- **WhatsApp:** `send_whatsapp_text`, `send_whatsapp_image` (inside the 24-hour customer care window),
  `send_whatsapp_template` (approved templates, any time), `send_whatsapp_custom` (any WhatsApp message object:
  media/interactive templates, buttons, lists; `to`, `from` and `recipient_type` inside `custom` are refused)
- **Number Insight:** `number_insight` (basic, standard or advanced)
- **Account:** `get_balance`

Full reference: [OPERATIONS.md](OPERATIONS.md). There is no `api_request`: Messages has no other read resources and
Number Insight GETs are billed.

Phone numbers (`to`, and `from` for WhatsApp) must be E.164 **with the `+`** (`+6281234567890`); the plugin sends
them without it, as Vonage expects. National numbers (`0812...`) and bare digits are refused, because they could be
read with the wrong country code. SMS `from` may also be an alphanumeric sender id where the country allows it.

Sends return `{message_uuid}` (202 Accepted). Delivery status arrives on the status webhook of your Vonage
application or account; the plugin never sets a per-message `webhook_url` (Vonage would post status data there).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Vonage API account; for WhatsApp, a WhatsApp Business number linked to a Vonage application (or the Messages
  API Sandbox)

## Installation
```bash
graphrt plugin install ./vonage
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `VONAGE_API_KEY` | yes | API key (Basic auth user) |
| `VONAGE_API_SECRET` | yes | API secret (Basic auth password) |
| `VONAGE_MESSAGES_REGION` | no | `eu`, `us` or `ap` to use `api-<region>.nexmo.com` for Messages (default `api.nexmo.com`) |
| `VONAGE_TOOL_ALLOW_SEND` | no | `1` lets agent tools use the send operations |
| `VONAGE_TOOL_RECIPIENT_ALLOWLIST` | for agent sends | Comma-separated recipients agent tools may send to: full E.164 numbers, matched exactly (`+6281234567890`), or prefixes with a trailing `*` and at least 4 digits (`+62812*`). `+1*`, `+62*` and other broad prefixes are refused |
| `VONAGE_TOOL_ALLOW_INSIGHT` | no | `1` lets agent tools use the paid `standard` and `advanced` Number Insight levels (`basic` is always allowed) |

A node can pass `access_token` to use another API secret for the same key (needs `--trust-plugin vonage`).

### Getting the credentials
1. Sign up at <https://dashboard.nexmo.com/sign-up> and copy the **API key** and **API secret** from the dashboard
   home page (or API Settings).
2. In API Settings, set the default SMS setting to the **Messages API** so inbound and status webhooks use the
   Messages format.
3. For WhatsApp, use the [Messages Sandbox](https://dashboard.nexmo.com/messages/sandbox) for testing, or link a
   WhatsApp Business number (Messages → External accounts) and create templates in WhatsApp Manager.

Basic auth covers everything here. JWT (application) auth is not implemented, so features that need it are not
available: marking inbound WhatsApp messages as read (`PATCH /v1/messages/{uuid}`), ACLs and Identity Insights.

## Pricing
Every send is billed: SMS per segment and destination, WhatsApp per template category or conversation plus a
Vonage fee. Number Insight standard and advanced are billed per request (the response shows `request_price` and
`remaining_balance`); CNAM adds a US charge. See <https://www.vonage.com/communications-apis/pricing/>. The Messages
API has no idempotency key, so sends and insights are never retried after a timeout or 5xx: the error says
"outcome unknown"; check the dashboard's message logs (or `client_ref` in your status webhook) first.

Vonage has announced the sunset of Number Insight on 4 February 2027 in favour of Identity Insights (JWT only).

## Toll fraud (SMS pumping)
An agent that can text any number in a country can be steered into sending to premium-rate numbers run by
fraudsters, who earn a share of each message. To keep that out of reach:
- List **exact numbers** in `VONAGE_TOOL_RECIPIENT_ALLOWLIST`. Use a `*` prefix only for a range you own, never a
  bare country code: the plugin refuses prefixes with fewer than 4 digits (`+1*`, `+62*`).
- In the Vonage dashboard, keep [Fraud Defender](https://developer.vonage.com/en/fraud-defender/overview) (SMS
  traffic and country restrictions) on, and allow only the destination countries you serve.
- Set a low balance or auto-reload limit so a runaway workflow cannot spend much.

## Quick Start
```bash
VONAGE_API_KEY=... VONAGE_API_SECRET=... graphrt run vonage/example.yaml --plugins .
```

## Usage
```yaml
- id: sms
  type: vonage.send_sms
  to: "+6281234567890"
  from: AcmeShop
  text: "Your code is {{#start.code#}}"
  client_ref: "order-{{#start.order_id#}}"
- id: template
  type: vonage.send_whatsapp_template
  to: "+6281234567890"
  from: "+14157386102"
  template_name: order_update
  template_parameters: ["Ada", "A-1001"]
  locale: id
```

## Agent policy
- `get_balance` and `number_insight` at level `basic` (free) are tools. The paid `standard` and `advanced` levels
  (billed per request, shown as `request_price`) are tools only with `VONAGE_TOOL_ALLOW_INSIGHT=1`; insights are
  never retried.
- Every send is a tool only with `VONAGE_TOOL_ALLOW_SEND=1` **and** a `VONAGE_TOOL_RECIPIENT_ALLOWLIST` matching
  the recipient (unset refuses every agent send; full numbers match exactly, `+62812*` matches by prefix). Workflow
  nodes are not limited by either.

## Errors
Messages errors are RFC 7807 (`title`, `detail`): 401 → `auth_error`, 403 → `permission_denied`, 422 →
`invalid_input`, 429 → `rate_limited`. Number Insight answers 200 with a non-zero `status`: 4 → `auth_error`,
1 → `rate_limited`, 3 → `invalid_input`, 9 (no credit) → `permission_denied`, others `api_error`. A bad
`VONAGE_MESSAGES_REGION` is refused before any request.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/vonage.test.mjs` covers the allowlist, E.164 and
sender handling, regions and Number Insight status errors; `test/recipient-policy.test.mjs` the policy module.
Verified live only with an invalid credential (`auth_error`); no real account was used.

## License
Apache-2.0
