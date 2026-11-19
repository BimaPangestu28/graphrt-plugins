# fonnte

**Status:** experimental · **ToS risk:** high. Unofficial WhatsApp gateway (Fonnte runs your number through WhatsApp Web); checked live only with an invalid token. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Fonnte](https://fonnte.com), an Indonesian
WhatsApp gateway that sends from your own WhatsApp number linked to a Fonnte "device"
([API docs](https://docs.fonnte.com/category/api/)): send messages and files, check which numbers are on WhatsApp,
read the device status and quota, and list groups.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
[`lib/recipient-policy.mjs`](lib/recipient-policy.mjs) validates phone numbers (E.164) and holds the agent
recipient allowlist.

## Features
- **Device:** `get_device` (number, connect/disconnect, package, remaining quota, expiry), `disconnect_device` (node only)
- **Messages:** `send_message` (one number; `message` and/or `file_url`; schedule, typing indicator),
  `send_group_message` (node only), `delete_message` (node only, pending or scheduled messages)
- **Numbers:** `validate_numbers` (which numbers are registered on WhatsApp; up to 500)
- **Groups:** `list_whatsapp_groups`, `fetch_whatsapp_groups` (node only; refreshes the list from WhatsApp)

Full reference: [OPERATIONS.md](OPERATIONS.md). There is no `api_request` (every Fonnte endpoint is a POST).

Numbers must be E.164 **with the `+`** (`+6281234567890`). The plugin sends the digits with `countryCode=0`, which
turns off Fonnte's default rewrite of a leading `0` to `62`, so a number is never read with a guessed country code.
`send_message` takes exactly one recipient: Fonnte's comma-separated multi-target sends (and its `data` batch) are
not exposed, so a workflow sends to many numbers with a loop and each send is checked.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Fonnte account with a device connected (a WhatsApp number linked by scanning the QR code in the dashboard)

## Installation
```bash
graphrt plugin install ./fonnte
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `FONNTE_TOKEN` | yes | Device token (Dashboard → Device → Token), sent as the `Authorization` header |
| `FONNTE_TOOL_ALLOW_SEND` | no | `1` lets agent tools use `send_message` |
| `FONNTE_TOOL_RECIPIENT_ALLOWLIST` | for agent sends | Comma-separated recipients agent tools may send to: full E.164 numbers, matched exactly (`+6281234567890`), or prefixes with a trailing `*` and at least 4 digits (`+62812*`). `+62*` and other broad prefixes are refused |

A node can pass `access_token` to use another device's token (needs `--trust-plugin fonnte`). The account token
(device management) is not used.

### Getting the token
1. Register at <https://md.fonnte.com/new/register.php> and add a device (your WhatsApp number).
2. Connect it: Device → Connect → scan the QR code in WhatsApp (Linked devices).
3. Device → Token: copy the token. Anyone with it can send from your number, so keep it secret.

## Pricing and limits
Fonnte sells monthly packages per device with a message quota (`get_device` shows `quota`); file sends need a paid
package (Super or higher). Sends that fail with "insufficient quota" are not saved. Sends are never retried after a
timeout or 5xx (Fonnte has no idempotency key): the error says "outcome unknown"; check the dashboard's message
report before sending again. WhatsApp may ban numbers that send unsolicited bulk messages; Fonnte warns
specifically against calling the group refresh often.

## Toll fraud and abuse
WhatsApp messages are not premium-rate, but an agent that can message any number can still spend your quota,
spam strangers and get the WhatsApp number banned. To keep that out of reach:
- List **exact numbers** in `FONNTE_TOOL_RECIPIENT_ALLOWLIST`. Use a `*` prefix only for a range you own, never a
  bare country code: the plugin refuses prefixes with fewer than 4 digits (`+62*`, `+1*`).
- Fonnte has no geo or pumping protection of its own: keep the device's package quota small for agent use and
  watch the message report.

## Quick Start
```bash
FONNTE_TOKEN=... graphrt run fonnte/example.yaml --plugins .
```

## Usage
```yaml
- id: check
  type: fonnte.validate_numbers
  numbers: ["+6281234567890"]
- id: send
  type: fonnte.send_message
  target: "+6281234567890"
  message: "Pesanan {{#start.order_id#}} sudah dikirim"
- id: invoice
  type: fonnte.send_message
  target: "+6281234567890"
  message: Invoice terlampir
  file_url: https://example.com/invoice.pdf
  filename: invoice.pdf
```

## Agent policy
- `get_device`, `validate_numbers` and `list_whatsapp_groups` are tools. `validate_numbers` is callable by agents
  without an opt-in or allowlist: it sends nothing, but it tells the agent whether any number (up to 500 per call)
  is on WhatsApp, and it uses your connected device to ask. Remove it from the agent's tools if that matters.
- `send_message` is a tool only with `FONNTE_TOOL_ALLOW_SEND=1` **and** a `FONNTE_TOOL_RECIPIENT_ALLOWLIST` matching
  the recipient (unset refuses every agent send; full numbers match exactly, `+62812*` matches by prefix). Workflow
  nodes are not limited by either.
- `send_group_message`, `delete_message`, `disconnect_device` and `fetch_whatsapp_groups` are node only.

## Errors
Fonnte answers HTTP 200 with `{"status": false, "reason": "..."}` (or `detail`; some responses spell it
`Status`, which is treated the same). `token invalid` / `invalid token`
→ `auth_error`, `insufficient quota` → `permission_denied`, `target invalid` / `input invalid` → `invalid_input`,
anything else (e.g. `device disconnected`) → `api_error` with Fonnte's text.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/fonnte.test.mjs` covers the header token, the
allowlist, E.164 and single-target checks, node-only operations and `status:false` errors;
`test/recipient-policy.test.mjs` the policy module. Verified live only with an invalid token (`auth_error`); no real
device was used.

## License
Apache-2.0
