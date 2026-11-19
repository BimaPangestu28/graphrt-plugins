# slack

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Slack Web API](https://docs.slack.dev/reference/methods).
It reads conversations, history and threads, posts and edits messages, manages reactions, looks up users, uploads
files (the current external-upload flow) and searches messages. Every operation is a workflow node; most are
agent tools as well (see "Agent policy").

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Two
operations are hand-written in [`lib/`](lib/): `upload_file` (three requests, the middle one to an upload URL from
the first response) and `search_messages` (needs a user token instead of the bot token).

## Features
- **Conversations:** `list_conversations`, `get_conversation_info`, `get_conversation_history`, `get_thread_replies`, `get_permalink`
- **Messages:** `post_message`, `update_message`, `delete_message` (node only)
- **Reactions:** `add_reaction`, `remove_reaction`, `get_reactions`
- **Users:** `auth_test`, `list_users`, `get_user_info`, `lookup_user_by_email`
- **Files:** `upload_file` (files.getUploadURLExternal → upload → files.completeUploadExternal; optional channel, comment and thread)
- **Search:** `search_messages` (search.messages with a user token; page-based `next_cursor`)
- **`api_request`:** any other Web API method. As an agent tool it is GET-only and limited to read methods
  (`*.list`, `*.info`, `*.history`, `*.replies`, `*.get*`, `*.lookup*`), because Slack also runs write methods
  sent as GET.

Lists return `next_cursor` (Slack's `response_metadata.next_cursor`); pass it back as `cursor`. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Slack app installed in the workspace

## Installation
```bash
graphrt plugin install ./slack
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot token (`xoxb-...`) used by every operation except search |
| `SLACK_USER_TOKEN` | for `search_messages` | User token (`xoxp-...`) with `search:read` |
| `SLACK_UPLOAD_DIR` | for local uploads | Directory `upload_file` may read local files from (https URLs work without it) |
| `SLACK_TOOL_ALLOW_SEND` | no | `1` lets agent tools post, edit and upload |

A node can pass `access_token` to use another bot token (needs `--trust-plugin slack`).

### Getting a token
1. Create an app at <https://api.slack.com/apps> (From scratch) and pick the workspace.
2. **OAuth & Permissions → Bot Token Scopes:** add what you need:
   `channels:read`, `groups:read`, `im:read`, `mpim:read` (list/info), `channels:history`, `groups:history`,
   `im:history`, `mpim:history` (history and threads), `chat:write` (post, edit, delete), `reactions:read`,
   `reactions:write`, `users:read`, `users:read.email`, `files:write` (uploads).
3. For search add the **User Token Scope** `search:read`.
4. Install the app to the workspace and copy the Bot User OAuth Token (and the User OAuth Token for search).
5. Invite the bot to the channels it should read or post in (`/invite @your-app`); otherwise Slack answers
   `not_in_channel`.

**Pricing / limits:** the Web API is free. Methods are rate limited per tier (e.g. chat.postMessage about 1
message per second per channel). Since 2025, `conversations.history` and `conversations.replies` for apps that
are not Marketplace-approved and installed outside their own workspace are limited to 1 request a minute and 15
messages per call; internal (custom) apps keep the normal limits.

## Quick Start
```bash
SLACK_BOT_TOKEN=xoxb-... graphrt run slack/example.yaml --plugins .
```

## Usage
```yaml
- id: post
  type: slack.post_message
  channel: C0123456789
  text: "Build {{#start.build#}} finished"
- id: react
  type: slack.add_reaction
  channel: C0123456789
  timestamp: "{{#post.data.ts#}}"
  name: white_check_mark
- id: upload
  type: slack.upload_file
  file: /srv/reports/weekly.pdf          # inside $SLACK_UPLOAD_DIR
  channel_id: C0123456789
  initial_comment: Weekly report
```

## Agent policy
- Reads (lists, history, users, reactions, search) are tools.
- `post_message`, `update_message` and `upload_file` are tools only with `SLACK_TOOL_ALLOW_SEND=1`.
- `delete_message` is node only.
- `add_reaction`/`remove_reaction` are tools without an opt-in. They are writes that other members see (and that
  can notify the message author), but they post no text; remove them from the agent's tools if that matters.
- `search_messages` sees everything the user token's owner can see, DMs included: only set `SLACK_USER_TOKEN`
  if agents may read that.

## Errors
Slack answers HTTP 200 with `{"ok": false, "error": "<code>"}`. The plugin maps the codes:
`invalid_auth`/`not_authed`/`token_revoked` → `auth_error`, `missing_scope`/`not_in_channel` →
`permission_denied`, `channel_not_found`/`message_not_found` → `not_found`, `invalid_arguments` and similar →
`invalid_input`, `ratelimited` and HTTP 429 → `rate_limited` (Retry-After is honoured). A failed `post_message`
or upload share is never retried after an unknown outcome: check the channel history first.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite; `test/slack.test.mjs` covers the upload flow, search,
the `ok:false` mapping and the api_request read-method guard. Verified live only with an invalid token
(`auth_error`); no real workspace was used.

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `upload_file` parameter `title` is now `file_title` (still sent to Slack as `title`). graphrt takes `title` from every workflow node, so the old name could never be set from a node; tool calls that passed `title` must use `file_title`.

## License
Apache-2.0
