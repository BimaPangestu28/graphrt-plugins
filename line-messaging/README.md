# line-messaging

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/): a LINE Official Account bot that
pushes and replies to messages, multicasts and broadcasts (node only), reads user profiles, followers and group
info, and checks the monthly message quota.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
[`lib/recipient-policy.mjs`](lib/recipient-policy.mjs) holds the agent recipient allowlist.

## Features
- **Send:** `push_message` (one user, group or room), `reply_message` (with a webhook reply token),
  `multicast_message` (up to 500 users, node only), `broadcast_message` (all friends, node only),
  `validate_push_messages` (check message objects, sends nothing), `show_loading_animation`
- **Users:** `get_profile`, `list_followers` (verified/premium accounts; `next_cursor`)
- **Groups:** `get_group_summary`, `get_group_member_count`, `get_group_member_profile`
- **Bot and quota:** `get_bot_info`, `get_quota`, `get_quota_consumption`, `get_push_message_count`
- **`api_request`:** any other endpoint on `api.line.me` (e.g. `/v2/bot/richmenu/list`; GET only for agents)

`messages` is an array of up to 5 [message objects](https://developers.line.biz/en/reference/messaging-api/#message-objects),
e.g. `[{"type": "text", "text": "Hello"}]`. Ids are LINE ids from webhook events (`U...` users, `C...` groups,
`R...` rooms, 32 hex characters), not LINE ids users show each other. Full reference: [OPERATIONS.md](OPERATIONS.md).

Receiving messages (webhooks) is not part of this plugin: point the channel's webhook at your own endpoint and
pass `replyToken` and ids from the events into a workflow.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A LINE Official Account with the Messaging API enabled

## Installation
```bash
graphrt plugin install ./line-messaging
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | yes | Channel access token (long-lived, or a v2.1 / stateless token you rotate yourself) |
| `LINE_TOOL_ALLOW_SEND` | no | `1` lets agent tools use `push_message` and `reply_message` |
| `LINE_TOOL_RECIPIENT_ALLOWLIST` | for agent pushes | Comma-separated user, group or room ids agent tools may push to (matched exactly; no wildcards) |

A node can pass `access_token` to use another channel's token (needs `--trust-plugin line-messaging`).

### Getting the token
1. Create a LINE Official Account (<https://entry.line.biz/>) and enable the Messaging API in its settings (this
   creates a channel in the [LINE Developers Console](https://developers.line.biz/console/)).
2. Developers Console → the channel → **Messaging API** tab → **Channel access token (long-lived)** → Issue.
3. To read user ids, set a webhook URL there and read `source.userId` from events; users must have added the
   account as a friend before you can push to them.

## Pricing
Reply messages are free. Push, multicast and broadcast messages count toward the monthly quota of the account's
plan, per recipient (e.g. the free Communication plan has a small monthly allowance, higher plans charge for extra
messages; prices differ by country): <https://www.lycbiz.com/jp/service/line-official-account/plan/> and
`get_quota` / `get_quota_consumption`. Push, multicast and broadcast send a fresh `X-Line-Retry-Key`, so the plugin
can retry a timeout or 5xx without delivering twice. If LINE had already accepted the first attempt, it answers
the retry with 409; the plugin returns that as success, `{already_accepted: true, accepted_request_id, note:
"... already sent; do not resend"}` (`accepted_request_id` is LINE's `x-line-accepted-request-id`, when sent). Replies have no retry key and are never retried.

## Quick Start
```bash
LINE_CHANNEL_ACCESS_TOKEN=... graphrt run line-messaging/example.yaml --plugins .
```

## Usage
```yaml
- id: push
  type: line-messaging.push_message
  to: U4af4980629a1b2c3d4e5f6a7b8c9d0e1
  messages:
    - { type: text, text: "Your order {{#start.order_id#}} has shipped" }
- id: reply
  type: line-messaging.reply_message
  reply_token: "{{#start.reply_token#}}"
  messages:
    - { type: text, text: "Thanks! We'll get back to you soon." }
```

## Agent policy
- Reads (profiles, followers, groups, quota, bot info), `validate_push_messages` and `show_loading_animation` are tools.
- `push_message` is a tool only with `LINE_TOOL_ALLOW_SEND=1` **and** the target id in
  `LINE_TOOL_RECIPIENT_ALLOWLIST` (unset refuses every agent push).
- `reply_message` needs only the opt-in (`LINE_TOOL_ALLOW_SEND=1`), not the allowlist: a reply token can only
  answer the chat that sent the event, so there is no recipient to choose.
- `multicast_message` and `broadcast_message` are node only: they reach many users and spend quota per recipient.
- Workflow nodes are not limited by the opt-in or the allowlist.

## Errors
LINE answers `{message, details: [{message, property}]}`: 400 → `invalid_input` (e.g. "Invalid reply token",
bad message objects), 401 → `auth_error`, 403 → `permission_denied` (e.g. followers on an unverified account),
404 → `not_found` (user is not a friend), 409 on push/multicast/broadcast → success with `already_accepted: true`
(see "Pricing"; any other 409 → `api_error`), 429 → `rate_limited`
(rate limit, or the monthly limit is reached).

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/line-messaging.test.mjs` covers the allowlist,
id checks, the retry key and node-only sends; `test/recipient-policy.test.mjs` the policy module. Verified live only
with an invalid token (`auth_error`); no real channel was used.

## License
Apache-2.0
