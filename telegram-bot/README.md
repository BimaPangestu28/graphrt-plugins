# telegram-bot

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Telegram Bot API**. It reads a
bot's updates by long polling, sends and edits messages, sends photos and documents, answers inline-keyboard
button presses and manages the webhook. Every operation is a workflow node; all except the webhook operations
are also agent tools.

## Features
- **Updates:** `get_updates` with a cursor (`next_cursor` = last `update_id` + 1), long polling up to 25 s
- **Sending:** text (MarkdownV2/HTML/Markdown, replies, silent, keyboards, forum topics), photos and documents by
  URL or `file_id`, chat actions ("typing…")
- **Messages:** edit text, delete, forward; answer callback queries
- **Info:** the bot itself, a chat, a chat's member count
- **Webhook (node only):** set, delete, get info
- **`api_request`:** any other Bot API method, by method name only. Agents (tool calls) may only use `get*` methods; anything that sends, pays or deletes must be a dedicated operation or a workflow node. `getUpdates`, the webhook methods, `logOut` and `close` are refused
- The bot token never appears in errors or responses (it is redacted everywhere, including `api_request`)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A bot token from [@BotFather](https://t.me/BotFather) (`/newbot`)

## Installation
```bash
graphrt plugin install ./telegram-bot
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token `"<bot id>:<secret>"` from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | no | Sent by `set_webhook` as `secret_token`: Telegram puts it in the `X-Telegram-Bot-Api-Secret-Token` header of every webhook call (1-256 of `A-Z a-z 0-9 _ -`) |

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can take
`access_token` to use another bot's token. Pass it from a secret and trust the plugin (`--trust-plugin telegram-bot`).

## Quick Start
```bash
export TELEGRAM_BOT_TOKEN=123456:ABC...
graphrt run telegram-bot/example.yaml --plugins .
```
The example only calls `get_me`; it sends nothing.

## Usage
```yaml
- id: updates
  type: telegram-bot.get_updates
  cursor: "{{#state.value#}}"      # e.g. from state-store; empty on the first run
  long_poll_seconds: 20
  allowed_updates: '["message","callback_query"]'
- id: reply
  type: telegram-bot.send_message
  chat_id: "{{#start.chat_id#}}"
  text: "Pesanan *{{#start.order_id#}}* sudah dikirim"
  parse_mode: MarkdownV2
  reply_markup: '{"inline_keyboard":[[{"text":"Lacak","callback_data":"track"}]]}'
```

### Reading updates
- Telegram keeps updates for 24 hours. A call with `offset` (`cursor`) confirms, and drops, every update below it.
- Pass `next_cursor` back as `cursor`, or store it (for example with the `state-store` plugin). Calling without a
  cursor returns the unconfirmed updates again, so you would see the same updates twice.
- `next_cursor` is null when no updates came back. Calling again without a cursor is then safe.
- `long_poll_seconds` (0-25 s) is the long-poll wait (sent to Telegram as `timeout`). The request gets its own
  timeout of `long_poll_seconds` + 10 s, which fits in the plugin's call limit.
- `get_updates` fails with a 409 conflict while a webhook is set, or while another process polls the same bot.

### Sending
- **No automatic resend.** Sends are POSTs. A send that fails with an unknown outcome (a timeout, network error or
  5xx) is not retried, so the message is never sent twice. Check the chat before sending again. A 429 (flood
  control) means nothing was sent: it is retried after Telegram's `retry_after` when that is 60 s or less.
- `chat_id` is a numeric id (`"123456789"`, `"-1001234567890"` for supergroups and channels) or `"@channelusername"`.
- **Photos and documents** are sent by http(s) URL (Telegram downloads them: photos up to 5 MB, other files up to
  20 MB, and documents by URL only work for PDF and ZIP) or by `file_id` of a file already on Telegram. Local file
  upload is not supported in this version.
- `reply_to_message_id` is sent as `reply_parameters.message_id`.

### Webhooks
`set_webhook`, `delete_webhook` and `get_webhook_info` are node only, because they change where the bot's updates
go. graphrt plugins can't receive webhooks, so use them only when your own receiver handles the updates.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments (chat id, lengths, local file paths, `api_request` paths); Telegram 400; group migrated to a supergroup (the new chat id is in the message) |
| `auth_error` | Missing, malformed or revoked token (401) |
| `permission_denied` | 403: the bot was blocked by the user, kicked, or lacks rights in the chat |
| `not_found` | 404 (unknown method); 400 "chat not found", "message to edit not found" |
| `rate_limited` | 429 flood control, with `retry_after` |
| `api_error` | 409 conflict (webhook set, or another getUpdates poller), 5xx |
| `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `get_updates` parameter `timeout` is now `long_poll_seconds` (still sent to Telegram as `timeout`). graphrt takes `timeout` from every workflow node, so the old name was silently dropped on nodes (every node poll returned at once); tool calls that passed `timeout` must use `long_poll_seconds`.

## License
Apache-2.0
