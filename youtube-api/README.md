# youtube-api

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **YouTube Data API v3**. It reads
the authenticated channel and its uploads, edits video metadata, moderates and answers comments, and reads and
writes live chat. Every operation is a workflow node and an agent tool.

## Features
- **Channel and videos:** my channel, my uploads, video details, metadata edits (merged, never cleared), delete
- **Comments:** list threads (per video or per channel, with search and moderation filters), list replies, post,
  reply, edit, delete, and moderate (publish / hold / reject, optionally ban the author)
- **Live chat:** read messages (with the server's polling interval) and send messages, by chat id or live video id
- **`api_request`:** any other YouTube Data API endpoint, restricted to `www.googleapis.com`
- Works with a plain access token or with a refresh token, which the plugin exchanges and caches itself
- Clear error kinds; the daily quota error is not retried. Tokens and client secrets never appear in errors.

YouTube has no DM API. Video upload is not included.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the YouTube Data API v3 enabled and an OAuth client
- An OAuth token for the channel's Google account with these scopes:

| Area | Scope |
|------|-------|
| Read only | `https://www.googleapis.com/auth/youtube.readonly` |
| Comments, moderation, live chat, metadata edits, delete | `https://www.googleapis.com/auth/youtube.force-ssl` |

## Installation
```bash
graphrt plugin install ./youtube-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
Set **either** an access token **or** the refresh trio.

| Env var | Description |
|---------|-------------|
| `YOUTUBE_ACCESS_TOKEN` | OAuth access token (expires after about an hour) |
| `YOUTUBE_REFRESH_TOKEN` | OAuth refresh token (needs `access_type=offline` when you authorize) |
| `YOUTUBE_CLIENT_ID` | OAuth client id that issued the refresh token |
| `YOUTUBE_CLIENT_SECRET` | OAuth client secret |

- With the trio, the plugin fetches an access token from `https://oauth2.googleapis.com/token` on the first call,
  caches it until a minute before it expires, and refreshes once when YouTube answers 401.
- With both set, `YOUTUBE_ACCESS_TOKEN` is used first and the trio takes over after a 401. The plugin remembers that
  token was rejected, so later runs go straight to the trio until `YOUTUBE_ACCESS_TOKEN` changes. If only part of the
  trio is set, the 401 error names the missing variables.
- `update_video_metadata` ignores an empty `description`; pass `clear_description: true` to remove it.
- A node can take `access_token` to use another account. That token is used as-is and is never refreshed. Pass it
  from a secret and trust the plugin (`--trust-plugin youtube-api`).

graphrt starts plugins with a clean environment, and only these variables are passed through.

## Quick Start
```bash
export YOUTUBE_ACCESS_TOKEN=...
graphrt run youtube-api/example.yaml --plugins .
```

## Usage
```yaml
- id: held
  type: youtube-api.list_comment_threads
  channel_id: "{{#start.channel_id#}}"
  moderation_status: heldForReview
- id: reply
  type: youtube-api.reply_to_comment
  parent_id: "{{#start.comment_id#}}"
  text: "Terima kasih sudah menonton!"
```
- **List operations** return `data` and `next_cursor`. Pass `next_cursor` back as `cursor` to get the next page.
- **`list_my_videos`** returns `{uploads_playlist_id, videos}`. Pass `uploads_playlist_id` on later calls to skip
  the channel lookup.
- **Live chat** always returns a `next_cursor`. Pass it back after `polling_interval_ms` to get only new messages.
- **Polling:** graphrt plugins can't receive webhooks. To react to new comments, run a workflow on a schedule.

## Quota
The default quota is 10,000 units per day, reset at midnight Pacific Time. Reads cost 1 unit (live chat reads 5);
writes cost 50 (`update_video_metadata` also does a 1-unit read first, live chat sends 20). `list_my_videos` without
`uploads_playlist_id` costs 2.

## Per-user tokens (multi-user agents)

Set `YOUTUBE_API_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin youtube-api`):

```yaml
tools: [youtube-api/get_my_channel]
tool_context:
  youtube-api:
    access_token: "{{#start.youtube_api_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Google OAuth access token of that user with the YouTube scopes.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `YOUTUBE_ACCESS_TOKEN`, `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, or HTTP 400 |
| `auth_error` | Missing, invalid or expired credentials, a rejected refresh token (`invalid_grant`), `authorizationRequired` |
| `permission_denied` | `forbidden`, `insufficientPermissions`, `commentsDisabled` |
| `rate_limited` | `rateLimitExceeded`/`userRateLimitExceeded` (retried) or `quotaExceeded`/`dailyLimitExceeded` (not retried: the quota resets daily) |
| `not_found` | `videoNotFound`, `commentNotFound` and other `*NotFound` reasons, or no channel / live chat |
| `api_error`, `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.2.0
- **Breaking:** `update_video_metadata` parameter `title` is now `video_title` (still sent to YouTube as `snippet.title`). graphrt takes `title` from every workflow node, so the old name was silently dropped on nodes; tool calls that passed `title` must use `video_title`.

## License
Apache-2.0
