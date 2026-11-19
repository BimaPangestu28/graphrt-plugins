# whatsapp-api

**Status:** beta · **ToS risk:** low. Official Cloud API; checked live only with an invalid token (190); sends are tested with fakes only. See [plugin status](../README.md#plugin-status).

> **0.4.0 (behaviour change for agents):** agent tool sends now need `WHATSAPP_TOOL_ALLOW_SEND=1` **and** the
> recipient in `WHATSAPP_TOOL_RECIPIENT_ALLOWLIST`, `update_business_profile` needs `WHATSAPP_TOOL_ALLOW_PROFILE=1`,
> `create_template` needs `WHATSAPP_TOOL_ALLOW_TEMPLATES=1`, and `delete_media` / `delete_template` are node only.
> Workflow nodes are unchanged. See [Agent policy](#agent-policy).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **WhatsApp Business Cloud API**. It
sends messages from a business phone number and manages media, message templates and the business profile.
Every operation is a workflow node. Agent tools are limited by the [agent policy](#agent-policy).

This plugin is for **business numbers** registered on the WhatsApp Business Platform. For a personal WhatsApp
account, see `whatsapp-web`.

## Features
- **Messaging:** text (with link preview and quote-reply), approved templates, media (image, video, audio,
  document, sticker), location, reply buttons, lists, reactions, and marking messages as read (with an optional typing indicator)
- **Media:** upload from an https URL (checked against WhatsApp's types and size limits), get a media download URL, delete media
- **Templates:** list, get, create (submit for review) and delete templates on the WhatsApp Business Account
- **Account:** list the account's phone numbers; read and update a number's business profile
- **`api_request`:** any other Graph endpoint, restricted to `graph.facebook.com`
- Phone numbers are validated as international E.164 numbers before anything is sent
- Clear error kinds for WhatsApp's error codes. Tokens never appear in errors.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Meta app with the WhatsApp product, a WhatsApp Business Account (WABA) and a registered phone number
- An access token with `whatsapp_business_messaging` (sending, media, profile) and
  `whatsapp_business_management` (templates, phone numbers). Use a **system user** token for anything long-lived;
  the temporary token from the App Dashboard expires after 24 hours.

## Installation
```bash
graphrt plugin install ./whatsapp-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | yes | System-user (or other) access token |
| `WHATSAPP_PHONE_NUMBER_ID` | for messaging, media upload and profile | Sending phone number id (not the phone number itself) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | for templates and `list_phone_numbers` | WhatsApp Business Account id |
| `WHATSAPP_GRAPH_VERSION` | no | Graph API version, default `v26.0` |
| `WHATSAPP_TOOL_ALLOW_SEND` | no | `1` lets **agent tools** send messages (see [Agent policy](#agent-policy)). Workflow nodes don't need it |
| `WHATSAPP_TOOL_RECIPIENT_ALLOWLIST` | with `WHATSAPP_TOOL_ALLOW_SEND` | Comma-separated numbers agent tools may message: full E.164 numbers (`+6281234567890`, matched exactly) or prefixes with at least 4 digits (`+62812*`). Unset refuses every agent send |
| `WHATSAPP_TOOL_ALLOW_PROFILE` | no | `1` lets agent tools `update_business_profile` (the public business profile) |
| `WHATSAPP_TOOL_ALLOW_TEMPLATES` | no | `1` lets agent tools `create_template` (templates can later be broadcast) |
| `WHATSAPP_TOOL_SEND_RATE_LIMIT` | no | Most messages **agent tools** may send per minute from this plugin process, default `20`; `0` turns the client-side limits off (see [Rate limits](#rate-limits)). Workflow nodes are not limited |

graphrt starts plugins with a clean environment, and only these variables are passed through. Each operation
also takes `phone_number_id` / `business_account_id` to override the defaults. A node can take `access_token`
to use another token. Pass it from a secret and trust the plugin (`--trust-plugin whatsapp-api`).

## Quick Start
```bash
export WHATSAPP_ACCESS_TOKEN=... WHATSAPP_BUSINESS_ACCOUNT_ID=... WHATSAPP_PHONE_NUMBER_ID=...
graphrt run whatsapp-api/example.yaml --plugins .
```
The example only reads (phone numbers and business profile); it sends nothing.

## Usage
```yaml
- id: welcome
  type: whatsapp-api.send_template
  to: "{{#start.phone#}}"
  name: order_update
  language: id
  components: '[{"type":"body","parameters":[{"type":"text","text":"{{#start.order_id#}}"}]}]'
- id: menu
  type: whatsapp-api.send_interactive_buttons
  to: "{{#start.phone#}}"
  body: "Ada yang bisa kami bantu?"
  buttons: '["Status pesanan", "Bicara dengan CS"]'
```

### Messaging rules
- **Templates first.** The first message to someone must be an approved template (`send_template`).
- **24-hour window.** Free-form messages (`send_text`, `send_media`, `send_location`, interactive messages)
  are only allowed within 24 hours of the person's last message to your number. Outside the window WhatsApp
  returns error 131047. The plugin reports this as `invalid_input` with a hint to use a template.
- **Opt-in.** Recipients must have agreed to receive messages from your business.
- **Numbers.** `to` must be an international number with country code (`6281234567890`, `+62 812-3456-7890`).
  Local numbers starting with `0` are rejected.
- **No automatic resend.** Sends are POSTs. If a send fails with an unknown outcome (a timeout or a 5xx), the
  plugin does not retry it, so the message is never sent twice. Check before sending again.

### Rate limits
WhatsApp enforces these limits itself (checked against Meta's docs on 2026-11-19):

| Limit | Value | Error when exceeded |
|-------|-------|---------------------|
| [Messaging limit](https://developers.facebook.com/docs/whatsapp/messaging-limits) | Unique users you can start a conversation with (template messages outside the 24 h window) in a rolling 24 h: 250, then 2,000, 10,000, 100,000 and unlimited. The limit is **shared by every number in the business portfolio**. Business verification (or 2,000 delivered high-quality templates in 30 days) unlocks 2,000; after that the limit goes up one level within about 6 h when quality is high and you used at least half of it in the last 7 days | The send is refused |
| [Throughput](https://developers.facebook.com/docs/whatsapp/throughput) | 80 messages per second per number by default; raised automatically to 1,000/s for numbers on an unlimited portfolio with high volume and a quality rating of yellow or better | 130429 (`rate_limited`, retried for up to 60 s) |
| [Pair rate limit](https://developers.facebook.com/docs/whatsapp/cloud-api/overview) | One message every 6 s to the same WhatsApp user (short bursts are allowed and borrowed from future capacity) | 131056 (`rate_limited`, not retried) |
| [Spam rate limit](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes) | Meta restricts numbers that send low-quality or unwanted messages | 131048 (`permission_denied`): stop sending and check the number's quality rating |

An agent stuck in a loop could hit these in seconds and hurt the number's quality rating. So **agent tool calls**
get client-side limits, kept in memory for the life of the plugin process:

- at most `WHATSAPP_TOOL_SEND_RATE_LIMIT` messages a minute (default 20) across every send operation (`send_text`,
  `send_template`, `send_media`, `send_location`, the interactive messages and `send_reaction`);
- one message every 6 s to the same recipient, so the pair rate limit is never hit from the plugin side.

A refused call fails with `rate_limited` (retryable, with the wait in the message) and never reaches WhatsApp.
`mark_as_read` is not counted. Workflow nodes are not limited, because the workflow author sets their volume.
Set `WHATSAPP_TOOL_SEND_RATE_LIMIT=0` to turn both client-side limits off. The messaging-limit tier can't be checked
from the plugin; read it in WhatsApp Manager.

### Incoming messages
Incoming messages, button replies and delivery or read statuses arrive **only by webhook**. graphrt plugins can't
receive webhooks, so this plugin can't read your inbox. To react to messages, run your own webhook receiver
(configured in the Meta App Dashboard) that starts a graphrt workflow. The workflow can then call `mark_as_read`,
`get_media_url` for received media, and the send operations.

### Pagination
`list_templates` and `list_phone_numbers` return `data` and `next_cursor`. Pass `next_cursor` back as `cursor` to get the next page.

### Media
- `upload_media` downloads the file (without credentials) and uploads it to WhatsApp. It returns
  `data.id`, which you pass to `send_media` as `media_id`. The URL and every redirect must be https on a public host
  (loopback, private and link-local addresses are refused).
- Size limits: image 5 MB (JPEG, PNG, static WebP; WhatsApp transcodes WebP to JPEG and rejects animated WebP),
  video 16 MB (MP4, 3GP), audio 16 MB, document 100 MB, sticker 500 KB (WebP).
- `mime_type` is used only when the server reports no content type or `application/octet-stream`; a specific type from
  the server always wins.
- Without `filename`, the upload is named `upload.<extension>` from the MIME type (e.g. `upload.pdf`).
- You can also skip uploading and pass a public https `link` to `send_media`.

## Agent policy
- Reads (`get_media_url`, templates, phone numbers, business profile), `upload_media` and `mark_as_read` are
  tools. `api_request` is GET only for tools.
- `update_business_profile` changes the public business profile (about, description, websites, email, photo), so it
  is a tool only with `WHATSAPP_TOOL_ALLOW_PROFILE=1`.
- `create_template` submits a template that can later be broadcast, so it is a tool only with
  `WHATSAPP_TOOL_ALLOW_TEMPLATES=1`.
- Every send is a tool only with `WHATSAPP_TOOL_ALLOW_SEND=1` **and** the recipient in
  `WHATSAPP_TOOL_RECIPIENT_ALLOWLIST`: `send_text` (including replies with `reply_to_message_id`), `send_template`,
  `send_media`, `send_location`, `send_interactive_buttons`, `send_interactive_list` and `send_reaction`.
  - The allowlist holds full E.164 numbers, matched exactly after formatting is stripped (`+62 812-3456-7890` is
    `+6281234567890`), or prefixes ending in `*` with at least 4 digits after `+` (`+62812*`). Broader prefixes
    (`+62*`) are refused as a configuration error. An empty or unset allowlist refuses every agent send, so the
    opt-in alone never lets an agent message arbitrary numbers.
  - A refused send fails with `permission_denied`, reaches no API and does not use up the
    [rate limit](#rate-limits) budget.
- `delete_media` and `delete_template` are node only.
- Workflow nodes are never limited by the opt-ins, the allowlist or the rate limits.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments or phone numbers; Graph 100; WhatsApp 131008/131009 (bad parameters), 131021 (sending to yourself), 131047 (outside the 24 h window, use a template), 131051/131053 (unsupported message or media), 132000/132001/132005/132012 (template problems), 133010 (number not registered) |
| `auth_error` | Missing, invalid or expired token (Graph 0, 102, 190; HTTP 401) |
| `permission_denied` | Agent tool call without its opt-in, or a send to a number outside the allowlist ([Agent policy](#agent-policy)); missing permission (3, 10, 200–299, 131005); account or number restricted (368, 131031, 131048); billing (131042); template paused or disabled (132007, 132015, 132016) |
| `rate_limited` | Throttling (4, 80007, 130429) is retried automatically for up to 60 s. Per-recipient pair limit (131056) is not retried; wait before messaging that person again. Agent sends over the [client-side limits](#rate-limits) (retryable, nothing was sent) |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named |

Delivery failures that happen after WhatsApp accepts a message (for example 131026, recipient not on WhatsApp)
are reported only through status webhooks, not to the send call.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.4.0
- **Behaviour change for agents:** agent tool sends of every message type need `WHATSAPP_TOOL_ALLOW_SEND=1` and the
  recipient in `WHATSAPP_TOOL_RECIPIENT_ALLOWLIST` (exact E.164 numbers or `+digits*` prefixes of at least 4 digits).
  `mark_as_read` stays free. `delete_media` and `delete_template` are node only. Workflow nodes are unchanged.
- **Behaviour change for agents:** `update_business_profile` needs `WHATSAPP_TOOL_ALLOW_PROFILE=1` and
  `create_template` needs `WHATSAPP_TOOL_ALLOW_TEMPLATES=1` as agent tools. `upload_media` stays free.

### 0.3.0
- Agent tool sends are rate limited per plugin process: `WHATSAPP_TOOL_SEND_RATE_LIMIT` per minute (default 20) and
  one message every 6 s to the same recipient. `0` turns the limits off. Workflow nodes are unchanged.
- The README documents Meta's current messaging limits, throughput and pair rate limit.

### 0.2.0
- **Breaking:** `send_media` and `upload_media` parameter `type` is now `media_type` (`send_media` still sends it to WhatsApp as the message `type`). graphrt takes `type` from every workflow node, so the old name could never be set from a node (the required field made the node fail to load); tool calls that passed `type` must use `media_type`.

## License
Apache-2.0
