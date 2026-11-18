# whatsapp-api

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **WhatsApp Business Cloud API**. It
sends messages from a business phone number and manages media, message templates and the business profile.
Every operation is a workflow node and an agent tool.

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

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments or phone numbers; Graph 100; WhatsApp 131008/131009 (bad parameters), 131021 (sending to yourself), 131047 (outside the 24 h window, use a template), 131051/131053 (unsupported message or media), 132000/132001/132005/132012 (template problems), 133010 (number not registered) |
| `auth_error` | Missing, invalid or expired token (Graph 0, 102, 190; HTTP 401) |
| `permission_denied` | Missing permission (3, 10, 200–299, 131005); account or number restricted (368, 131031, 131048); billing (131042); template paused or disabled (132007, 132015, 132016) |
| `rate_limited` | Throttling (4, 80007, 130429) is retried automatically for up to 60 s. Per-recipient pair limit (131056) is not retried; wait before messaging that person again |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named |

Delivery failures that happen after WhatsApp accepts a message (for example 131026, recipient not on WhatsApp)
are reported only through status webhooks, not to the send call.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## License
Apache-2.0
