# slack operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `slack.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `auth_test` | Who the token belongs to: team, user and bot ids |  |
| `list_conversations` | List channels the token can see (public by default; private, mpim and im with the matching scopes) | types, exclude_archived, team_id, cursor, limit |
| `get_conversation_info` | Details of one conversation: name, topic, purpose, membership | **channel**, include_num_members |
| `get_conversation_history` | Messages of a conversation, newest first (thread replies are fetched with get_thread_replies) | **channel**, oldest, latest, inclusive, cursor, limit |
| `get_thread_replies` | A thread: the parent message followed by its replies | **channel**, **ts**, oldest, latest, inclusive, cursor, limit |
| `get_permalink` | Permanent URL of a message | **channel**, **message_ts** |
| `get_reactions` | Reactions on a message | **channel**, **timestamp**, full |
| `list_users` | Members of the workspace (needs users:read; emails need users:read.email) | include_locale, team_id, cursor, limit |
| `get_user_info` | Profile of one user | **user**, include_locale |
| `lookup_user_by_email` | Find a user by email address (needs users:read.email) | **email** |
| `post_message` | Post a message to a channel, DM or thread (as an agent tool only when SLACK_TOOL_ALLOW_SEND=1) | **channel**, text, blocks, thread_ts, reply_broadcast, unfurl_links, unfurl_media, mrkdwn |
| `update_message` | Replace the text or blocks of a message the token posted (as an agent tool only when SLACK_TOOL_ALLOW_SEND=1) | **channel**, **ts**, text, blocks |
| `delete_message` | Delete a message permanently | **channel**, **ts** |
| `add_reaction` | Add an emoji reaction to a message (a repeat answers already_reacted) | **channel**, **timestamp**, **name** |
| `remove_reaction` | Remove the token's emoji reaction from a message | **channel**, **timestamp**, **name** |
| `upload_file` | Upload a file (https URL, or an absolute path inside $SLACK_UPLOAD_DIR) and optionally share it in a channel or thread (as an agent tool only when SLACK_TOOL_ALLOW_SEND=1) | **file**, filename, title, channel_id, initial_comment, thread_ts |
| `search_messages` | Search messages the user can see with Slack search syntax (in:#channel from:@user before:2026-01-01); needs a user token in SLACK_USER_TOKEN | **query**, sort, sort_dir, highlight, limit, cursor |
| `api_request` | Call any Slack Web API endpoint that has no dedicated operation, e.g. path "/team.info". Only the API's own host is allowed. Agent tools may only call read methods (*.list, *.info, *.history, *.replies, *.get*, *.lookup*). | method, **path**, query, body |
