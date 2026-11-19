# discord

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Discord REST API v10](https://discord.com/developers/docs/reference)
with a bot token: servers (guilds), channels, messages, reactions, members and threads. It uses only HTTP (no
Gateway connection), so it reads and sends on demand; it does not receive events.

Built with the [declarative REST layer](../docs/declarative-plugins.md): the whole plugin is
[`definition.mjs`](definition.mjs).

## Features
- **Bot and servers:** `get_current_user`, `list_my_guilds`, `get_guild`, `list_guild_channels`
- **Members:** `list_guild_members`, `search_guild_members`, `get_guild_member`
- **Messages:** `list_messages` (newest first, `next_cursor` pages back in time), `get_message`, `send_message`
  (optional reply), `edit_message`, `delete_message` (node only)
- **Reactions:** `add_reaction`, `remove_own_reaction`, `list_reactions`
- **Threads:** `list_active_threads`, `list_public_archived_threads`, `start_thread_from_message`, `start_thread`
  (send into a thread with `send_message` and the thread id as `channel_id`)
- **`api_request`:** any other endpoint (GET only for agents)

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Discord application with a bot, invited to the server

## Installation
```bash
graphrt plugin install ./discord
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Bot token, sent as `Authorization: Bot <token>` |
| `DISCORD_TOOL_ALLOW_SEND` | no | `1` lets agent tools send and edit messages and start threads |
| `DISCORD_TOOL_ALLOW_MASS_MENTIONS` | no | `1` lets agent tools ping @everyone, @here or roles |

A node can pass `access_token` (another bot token; needs `--trust-plugin discord`).

### Getting a token
1. <https://discord.com/developers/applications> → New Application → **Bot** → Reset Token, copy it.
2. **Privileged Gateway Intents:** enable **Server Members Intent** for `list_guild_members`/`search_guild_members`,
   and **Message Content Intent** to see the content of other users' messages (without it `content` is empty
   except for DMs, mentions and the bot's own messages).
3. **OAuth2 → URL Generator:** scope `bot`, permissions such as View Channels, Read Message History, Send Messages,
   Send Messages in Threads, Create Public Threads, Add Reactions, Manage Messages (to delete others' messages).
   Open the URL and add the bot to the server.

**Pricing / limits:** free. Discord rate limits per route and globally (50 requests a second per bot); a 429
carries `retry_after`, which the plugin honours before retrying.

## Quick Start
```bash
DISCORD_BOT_TOKEN=... graphrt run discord/example.yaml --plugins .
```

## Usage
```yaml
- id: notify
  type: discord.send_message
  channel_id: "123456789012345678"       # quote snowflakes: they are larger than JSON numbers can hold exactly
  content: "Deploy {{#start.version#}} is live"
- id: thumbs
  type: discord.add_reaction
  channel_id: "123456789012345678"
  message_id: "{{#notify.data.id#}}"
  emoji: "👍"                             # custom emoji: name:id
```

`send_message` defaults to `allowed_mentions: {"parse": []}`: the text may contain `@everyone` or `<@id>` without
pinging anyone. Pass e.g. `allowed_mentions: {"parse": ["users"]}` to ping mentioned users.

## Agent policy
- Reads are tools.
- `send_message`, `edit_message`, `start_thread` and `start_thread_from_message` are tools only with
  `DISCORD_TOOL_ALLOW_SEND=1`.
- Tool sends may widen `allowed_mentions` to users, but pinging @everyone/@here (`parse: ["everyone"]`) or roles
  (`parse: ["roles"]` or a `roles` list) also needs `DISCORD_TOOL_ALLOW_MASS_MENTIONS=1`.
- `delete_message` is node only.
- `add_reaction`/`remove_own_reaction` are tools (they post no text).

## Errors
Discord errors are `{"code": 50001, "message": "Missing Access"}`; the message keeps the code. Mapped kinds:
401 → `auth_error`; 50001/50013 (missing access/permissions) → `permission_denied`; 10003/10004/10007/10008
(unknown channel/server/member/message) → `not_found`; 50035 (invalid form body) → `invalid_input`; 429 →
`rate_limited`. A failed `send_message` is never retried after an unknown outcome: check `list_messages` first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus Discord-specific cases (auth header, User-Agent, backwards paging, error codes,
rate limits). Verified live only with an invalid token (`auth_error`).

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `start_thread` parameter `type` is now `thread_type` (still sent to Discord as `type`). graphrt takes `type` from every workflow node, so the old name could never be set from a node; tool calls that passed `type` must use `thread_type`.

## License
Apache-2.0
