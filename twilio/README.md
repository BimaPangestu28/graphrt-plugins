# twilio

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Twilio REST API](https://www.twilio.com/docs/usage/api):
send SMS, MMS and WhatsApp messages, read message and call logs, place outbound calls (node only), validate numbers
with Lookup v2 and check the account balance.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
[`lib/recipient-policy.mjs`](lib/recipient-policy.mjs) validates phone numbers (E.164) and holds the agent
recipient allowlist; [`lib/twilio-paging.mjs`](lib/twilio-paging.mjs) turns Twilio's relative `next_page_uri`
into a `cursor`.

## Features
- **Messages:** `send_sms` (SMS/MMS), `send_whatsapp` (free-form or a Content template), `list_messages`,
  `get_message`, `delete_message` (node only)
- **Calls:** `list_calls`, `get_call`, `create_call` (node only: TwiML URL, inline TwiML or a TwiML App)
- **Lookup v2:** `lookup_phone_number` (free validation and formatting), `lookup_phone_number_data` (paid data
  packages: line type, caller name, SIM swap, call forwarding, line status, reassigned number, SMS pumping risk)
- **Account:** `get_balance`
- **`api_request`:** any other resource under `/2010-04-01/Accounts/{AccountSid}` (e.g. `/Recordings.json`; GET only
  for agents)

Lists return `next_cursor`; pass it back as `cursor`. Full reference: [OPERATIONS.md](OPERATIONS.md).

Phone numbers (`to`, and `from` for WhatsApp and calls) must be E.164 **with the `+`** (`+6281234567890`): a national
number (`0812...`) or bare digits are refused, because they could be read with the wrong country code and reach a
stranger. `send_whatsapp` adds the `whatsapp:` prefix itself.

No operation takes a `StatusCallback`: Twilio would post message and call data to that URL. Use the Console's
Messaging Service or phone number webhook settings for delivery status instead.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Twilio account; for WhatsApp, the WhatsApp Sandbox or an approved WhatsApp sender

## Installation
```bash
graphrt plugin install ./twilio
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | yes | Account SID (`AC` + 32 hex characters); Basic auth user and part of every path |
| `TWILIO_AUTH_TOKEN` | yes | Auth token (Basic auth password) |
| `TWILIO_TOOL_ALLOW_SEND` | no | `1` lets agent tools use `send_sms` and `send_whatsapp` |
| `TWILIO_TOOL_RECIPIENT_ALLOWLIST` | for agent sends | Comma-separated recipients agent tools may send to: full E.164 numbers, matched exactly (`+6281234567890`), or prefixes with a trailing `*` and at least 4 digits (`+62812*`). `+1*`, `+62*` and other broad prefixes are refused |
| `TWILIO_TOOL_ALLOW_LOOKUP` | no | `1` lets agent tools use the paid `lookup_phone_number_data` |

A node can pass `access_token` to use another auth token for the same Account SID (needs `--trust-plugin twilio`).

### Getting the credentials
1. Sign up at <https://www.twilio.com/try-twilio> and open the [Console](https://console.twilio.com/).
2. Copy the **Account SID** and **Auth token** from the Account Info panel.
3. Buy or verify a sender: a Twilio phone number (Phone Numbers → Buy a number), a Messaging Service, or for
   WhatsApp the Sandbox (Messaging → Try it out → Send a WhatsApp message) or a registered WhatsApp sender.
4. Trial accounts can only send to verified caller ids and prefix messages with "Sent from a Twilio trial account".

## Pricing
Everything that sends costs money: SMS and MMS are billed per segment (160 GSM-7 or 70 UCS-2 characters) and
destination country, WhatsApp per conversation or template category plus a Twilio fee, calls per minute, and Lookup
data packages per request (basic Lookup validation is free). See <https://www.twilio.com/en-us/pricing>. Sends,
calls and paid lookups are never retried after a timeout or 5xx (Twilio has no idempotency key for these), so a
failure says "outcome unknown": check `list_messages` / `list_calls` before trying again.

## Toll fraud (SMS pumping)
An agent that can text any number in a country can be steered into sending to premium-rate numbers run by
fraudsters, who earn a share of each message. To keep that out of reach:
- List **exact numbers** in `TWILIO_TOOL_RECIPIENT_ALLOWLIST`. Use a `*` prefix only for a range you own (e.g. your
  company's block), never a bare country code: the plugin refuses prefixes with fewer than 4 digits (`+1*`,
  `+62*`).
- In the Console, turn on [Messaging Geo Permissions](https://console.twilio.com/us1/develop/sms/settings/geo-permissions)
  for only the countries you serve, and [SMS Pumping Protection](https://www.twilio.com/docs/messaging/features/sms-pumping-protection-programmable-messaging)
  on your Messaging Service; for calls, Voice Geographic Permissions.
- Set usage triggers or a low balance on the account, and keep `create_call` node only.

## Quick Start
```bash
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... graphrt run twilio/example.yaml --plugins .
```

## Usage
```yaml
- id: sms
  type: twilio.send_sms
  to: "+6281234567890"
  from: "+15005550006"
  body: "Your order {{#start.order_id#}} has shipped"
- id: whatsapp
  type: twilio.send_whatsapp
  to: "+6281234567890"
  from: "+14155238886"
  content_sid: HXb5b62575e6e4ff6129ad7c8efe1f983e
  content_variables: '{"1":"12/1","2":"3pm"}'
- id: status
  type: twilio.get_message
  message_sid: "{{#sms.data.sid#}}"
```

## Agent policy
- Reads (messages, calls, free lookup, balance) are tools.
- `send_sms` and `send_whatsapp` are tools only with `TWILIO_TOOL_ALLOW_SEND=1` **and** a
  `TWILIO_TOOL_RECIPIENT_ALLOWLIST` that matches the recipient (an unset allowlist refuses every agent send; full
  numbers match exactly, `+62812*` matches by prefix). Workflow nodes are not limited by either.
- `create_call` and `delete_message` are node only: calls cost money and ring a real phone.
- `lookup_phone_number_data` is paid (billed per data package and lookup; prices per package are on
  <https://www.twilio.com/en-us/user-authentication-identity/pricing/lookup>): a tool only with
  `TWILIO_TOOL_ALLOW_LOOKUP=1`, "unsafe" and never retried. The basic `lookup_phone_number` is free and always a tool.

## Errors
Twilio answers `{code, message, more_info, status}`. `20003` (and HTTP 401) → `auth_error`, `20404` → `not_found`,
`20429` and HTTP 429 → `rate_limited`, `21211` (invalid To) → `invalid_input`, `21610` (recipient replied STOP) →
`permission_denied`; the message includes the code (look it up at <https://www.twilio.com/docs/api/errors>).
A bad `TWILIO_ACCOUNT_SID` is refused before any request (`invalid_input`).

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/twilio.test.mjs` covers the allowlist, E.164
checks, the WhatsApp prefix, paging cursors and error mapping; `test/recipient-policy.test.mjs` the policy module.
Verified live only with an invalid credential (`auth_error`); no real account was used.

## License
Apache-2.0
