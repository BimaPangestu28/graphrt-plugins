# wablas

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Wablas](https://wablas.com), an Indonesian
WhatsApp gateway that sends from your WhatsApp number linked to a Wablas device
([API docs](https://pati.wablas.com/documentation/api); every server hosts the same docs): send text, images,
documents and videos, read message reports, cancel pending messages and read the device status and quota.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
`get_device_info` is hand-written in [`lib/device-info.mjs`](lib/device-info.mjs) because Wablas wants the token
in its query string there, unlike every other endpoint. [`lib/recipient-policy.mjs`](lib/recipient-policy.mjs)
validates phone numbers (E.164) and holds the agent recipient allowlist.

## Features
- **Sending (v2 API):** `send_message`, `send_image`, `send_document`, `send_video` (one number per call, media
  by public URL, optional `ref_id`; `send_video` needs a `caption`)
- **Reports:** `list_message_reports` (filter by phone, ref_id, status, date or message id; page-based `next_cursor`)
- **Messages:** `cancel_message` (pending only), `resend_message` (node only)
- **Device:** `get_device_info` (name, sender number, connected/disconnected, quota, expiry)

Full reference: [OPERATIONS.md](OPERATIONS.md). There is no `api_request`: Wablas runs several writes as GET
(cancel, resend, blacklist), so a "read-only" GET passthrough would not be read-only.

Numbers must be E.164 **with the `+`** (`+6281234567890`); the plugin sends the digits. National numbers
(`0812...`) are refused, because Wablas accepts numbers "with the country code prefix or not" and would have to
guess. The v2 endpoints take up to 50 rows per request; the plugin sends exactly one, so every recipient is checked.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Wablas account with a connected device

## Installation
```bash
graphrt plugin install ./wablas
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `WABLAS_DOMAIN` | yes | Your Wablas server host, e.g. `pati.wablas.com`, `jkt.wablas.com`, `solo.wablas.com` (an `https://` URL is accepted); must end in `.wablas.com` |
| `WABLAS_TOKEN` | yes | Device token |
| `WABLAS_SECRET_KEY` | yes for current accounts | Secret key; requests send `Authorization: <token>.<secret_key>` (only the token when unset) |
| `WABLAS_TOOL_ALLOW_SEND` | no | `1` lets agent tools use the send operations and `cancel_message` |
| `WABLAS_TOOL_RECIPIENT_ALLOWLIST` | for agent sends | Comma-separated recipients agent tools may send to: full E.164 numbers, matched exactly (`+6281234567890`), or prefixes with a trailing `*` and at least 4 digits (`+62812*`). `+62*` and other broad prefixes are refused |

A node can pass `access_token` to use another device token for the declarative operations (needs
`--trust-plugin wablas`); `get_device_info` always uses `WABLAS_TOKEN`.

### Getting the credentials
1. Register at <https://wablas.com>, buy a package and add a device; connect it by scanning the QR code in WhatsApp
   (Linked devices).
2. Device → Settings shows the **token**, the **secret key** and the server domain (the host of the dashboard URL,
   e.g. `https://jkt.wablas.com`).
3. If the device has an IP whitelist, add the machine that runs graphrt.

## Pricing and limits
Wablas sells monthly packages per device with a message quota (shown by `get_device_info` and in send
responses). The API allows 200 requests and 10,000 recipient rows per credential per minute (HTTP 429 with
`retry_after`). Sends are never retried after a timeout or 5xx (Wablas has no idempotency key): the error says
"outcome unknown"; check `list_message_reports` (by phone or `ref_id`) before sending again. WhatsApp may ban numbers
that send unsolicited bulk messages.

## Toll fraud and abuse
WhatsApp messages are not premium-rate, but an agent that can message any number can still spend your quota,
spam strangers and get the WhatsApp number banned. To keep that out of reach:
- List **exact numbers** in `WABLAS_TOOL_RECIPIENT_ALLOWLIST`. Use a `*` prefix only for a range you own, never a
  bare country code: the plugin refuses prefixes with fewer than 4 digits (`+62*`, `+1*`).
- Wablas has no geo or pumping protection of its own: use the device's IP whitelist, keep the package quota small
  for agent use and watch `list_message_reports`.

## Quick Start
```bash
WABLAS_DOMAIN=pati.wablas.com WABLAS_TOKEN=... WABLAS_SECRET_KEY=... graphrt run wablas/example.yaml --plugins .
```

## Usage
```yaml
- id: send
  type: wablas.send_message
  phone: "+6281234567890"
  message: "Pesanan {{#start.order_id#}} sudah dikirim"
  ref_id: "order-{{#start.order_id#}}"
- id: report
  type: wablas.list_message_reports
  ref_id: "order-{{#start.order_id#}}"
```

## Agent policy
- `get_device_info` and `list_message_reports` are tools.
- `cancel_message` is a tool only with `WABLAS_TOOL_ALLOW_SEND=1` (it changes what gets delivered).
- The four sends are tools only with `WABLAS_TOOL_ALLOW_SEND=1` **and** a `WABLAS_TOOL_RECIPIENT_ALLOWLIST` matching
  the recipient (unset refuses every agent send; full numbers match exactly, `+62812*` matches by prefix). Workflow
  nodes are not limited by either.
- `resend_message` is node only (its recipient is not known before the call).

## Errors
Wablas answers `{"status": false, "message": "..."}` with an HTTP error or 200: 401 (`Unauthenticated.`) →
`auth_error`, 403 (access denied, IP not whitelisted) → `permission_denied`, 404 → `not_found`, 422 →
`invalid_input`, 429 → `rate_limited` (with `retry_after`). Business errors arrive as HTTP 500 (or 200) with a fixed
message, matched case-insensitively: "token invalid", "token invalid or device expired", "token is null" and
"secret key invalid" → `auth_error`, "quota is not enough, please top up your quota." → `permission_denied` (these are not retried and are not "outcome unknown"); other 5xx and
`status:false` bodies → `api_error` with Wablas's message. A bad `WABLAS_DOMAIN` is refused before any request.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite (with a `checkAuth` for the token.secret header);
`test/wablas.test.mjs` covers device info, the domain check, the allowlist, the simple send fields and
`status:false`; `test/recipient-policy.test.mjs` the policy module. Verified live only with an invalid token; no real
device was used.

## License
Apache-2.0
