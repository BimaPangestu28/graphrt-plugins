# discord operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `discord.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_current_user` | The bot's own user |  |
| `list_my_guilds` | Servers (guilds) the bot is in | with_counts, cursor, limit |
| `get_guild` | One server | **guild_id**, with_counts |
| `list_guild_channels` | Channels of a server (not threads) | **guild_id** |
| `list_guild_members` | Members of a server (needs the privileged Server Members intent) | **guild_id**, cursor, limit |
| `search_guild_members` | Members whose username or nickname starts with a query | **guild_id**, **query**, limit |
| `get_guild_member` | One member of a server | **guild_id**, **user_id** |
| `get_channel` | A channel or thread | **channel_id** |
| `list_messages` | Messages of a channel, newest first (needs the Message Content intent to see content of others' messages) | **channel_id**, cursor, limit |
| `get_message` | One message | **channel_id**, **message_id** |
| `list_reactions` | Users who reacted to a message with one emoji | **channel_id**, **message_id**, **emoji**, cursor, limit |
| `list_active_threads` | Active threads of a server | **guild_id** |
| `list_public_archived_threads` | Archived public threads of a channel, newest first (has_more says whether to ask again with before) | **channel_id**, before, limit |
| `send_message` | Send a message to a channel or thread (optionally as a reply) (as an agent tool only when DISCORD_TOOL_ALLOW_SEND=1) | **channel_id**, content, embeds, allowed_mentions, reply_to |
| `edit_message` | Edit a message the bot sent (as an agent tool only when DISCORD_TOOL_ALLOW_SEND=1) | **channel_id**, **message_id**, content, embeds |
| `delete_message` | Delete a message | **channel_id**, **message_id** |
| `add_reaction` | React to a message as the bot | **channel_id**, **message_id**, **emoji** |
| `remove_own_reaction` | Remove the bot's reaction from a message | **channel_id**, **message_id**, **emoji** |
| `start_thread_from_message` | Start a thread on an existing message (as an agent tool only when DISCORD_TOOL_ALLOW_SEND=1) | **channel_id**, **message_id**, **name**, auto_archive_duration |
| `start_thread` | Start a thread without a starter message (public by default) (as an agent tool only when DISCORD_TOOL_ALLOW_SEND=1) | **channel_id**, **name**, thread_type, auto_archive_duration, invitable |
| `api_request` | Call any Discord REST API endpoint that has no dedicated operation, e.g. path "/users/@me". Only the API's own host is allowed. | method, **path**, query, body |
