# microsoft-teams operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `microsoft-teams.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | The signed-in user (who the refresh token belongs to) |  |
| `list_joined_teams` | Teams the signed-in user is a member of | cursor |
| `get_team` | One team's settings | **team_id** |
| `list_team_members` | Members of a team | **team_id**, cursor |
| `list_channels` | Channels of a team | **team_id**, select, filter, cursor |
| `get_channel` | One channel | **team_id**, **channel_id** |
| `list_channel_members` | Members of a channel | **team_id**, **channel_id**, cursor |
| `list_channel_messages` | Top-level messages of a channel, newest first (replies with list_message_replies or expand_replies) | **team_id**, **channel_id**, expand_replies, cursor, limit |
| `get_channel_message` | One channel message | **team_id**, **channel_id**, **message_id** |
| `list_message_replies` | Replies to a channel message | **team_id**, **channel_id**, **message_id**, cursor, limit |
| `send_channel_message` | Post a new message in a channel (as an agent tool only when MICROSOFT_TEAMS_TOOL_ALLOW_SEND=1) | **team_id**, **channel_id**, **content**, content_type, subject |
| `reply_to_channel_message` | Reply to a channel message (as an agent tool only when MICROSOFT_TEAMS_TOOL_ALLOW_SEND=1) | **team_id**, **channel_id**, **message_id**, **content**, content_type |
| `list_chats` | 1:1, group and meeting chats of the signed-in user | expand_members, filter, order_by, cursor, limit |
| `get_chat` | One chat | **chat_id** |
| `list_chat_messages` | Messages of a chat | **chat_id**, order_by, filter, cursor, limit |
| `send_chat_message` | Send a message in a chat (as an agent tool only when MICROSOFT_TEAMS_TOOL_ALLOW_SEND=1) | **chat_id**, **content**, content_type |
| `api_request` | Call any Microsoft Graph (Teams) endpoint that has no dedicated operation, e.g. path "/me/joinedTeams". Only the API's own host is allowed. | method, **path**, query, body |
