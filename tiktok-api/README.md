# tiktok-api

**Status:** experimental · **ToS risk:** medium. Business API comment and DM field names come from a third-party client, not TikTok's docs; checked live only with an invalid token. See [plugin status](../README.md#plugin-status).

> **0.3.0 (behaviour change for agents):** agent tools may no longer post directly, comment, reply, hide or like
> comments, or send DMs by default. Direct posts, comments and replies need `TIKTOK_TOOL_ALLOW_POST=1`, comment
> moderation and likes need `TIKTOK_TOOL_ALLOW_ENGAGE=1`, DMs need `TIKTOK_TOOL_ALLOW_DM=1`, and `delete_comment` is
> node only. Inbox drafts and workflow nodes are unchanged. See [Agent policy](#agent-policy).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **TikTok APIs**. It uses two of them:

- **Open API** (`open.tiktokapis.com`): profile, video list, Content Posting (video and photo posts) and token refresh.
- **Business API** (`business-api.tiktok.com/open_api/v1.3`): comments and direct messages of a TikTok business account.

Every operation is a workflow node. Agent tools are limited by the [agent policy](#agent-policy).

## Features
- **Profile and videos:** user info, list videos (cursor paging), query videos by id, creator posting settings
- **Publishing:**
  - Post a video from a URL, directly or as an inbox draft.
  - Post 1–35 photos, directly or as an inbox upload.
  - Each publish checks the privacy level against `creator_info` first, then waits for TikTok to finish (polls every 5 s, up to 5 min).
- **Token refresh (node only):** `refresh_access_token` returns the rotated access and refresh tokens. It isn't offered to agents as a tool, so tokens never reach an LLM
- **Comments (Business API):** list, list replies, comment, reply, hide/unhide, like/unlike, delete
- **Messages (Business API):** list conversations, list messages, send a text message
- **`api_request`:** any other endpoint, with `api: open` or `api: business`, restricted to that API's host
- TikTok errors are mapped to stable kinds, including errors sent inside HTTP 200 bodies. Tokens never appear in errors.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A TikTok developer app with Login Kit. Get a user access token through your own OAuth flow; the plugin does not run the login.
- Open API scopes:

| Area | Scopes |
|------|--------|
| Profile | `user.info.basic`, `user.info.profile`, `user.info.stats` |
| Videos | `video.list` |
| Direct post | `video.publish` (Content Posting API, Direct Post enabled) |
| Inbox draft / photo upload | `video.upload` |

- For comments and messages: a TikTok API for Business app with access to the TikTok account (business) endpoints, and a
  business access token for the account.

### Important restrictions
- **Unaudited apps can only post `SELF_ONLY`.** Until TikTok audits your app, direct posts must use
  `privacy_level: SELF_ONLY` and the account must be private. Other levels fail with `permission_denied`
  (`unaudited_client_can_only_post_to_private_accounts`).
- **`PULL_FROM_URL` needs a verified domain.** `video_url` and `photo_urls` must be on a domain or URL prefix you verified in
  the TikTok developer portal. Otherwise TikTok returns `url_ownership_unverified` (`permission_denied`).
  The plugin does not upload local files.
- **Business API field names need live verification.** The research for the comment and message endpoints came from a
  third-party client, not from TikTok's documentation. This includes parameter names, list keys (`comments`,
  `conversations`, `messages`), `cursor`/`has_more`, and the `text: {body}` message shape. Check them against your
  account before you rely on them. If something differs, use `api_request` with `api: business` in the meantime.
- **Messaging is restricted.** The direct message endpoints need TikTok's approval and are only available in some regions.
  You can only reply within **48 hours** of the user's last message.

## Installation
```bash
graphrt plugin install ./tiktok-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `TIKTOK_ACCESS_TOKEN` | for Open API operations | User access token (Bearer). It is short-lived (see `expires_in`); refresh it with `refresh_access_token` |
| `TIKTOK_BUSINESS_ACCESS_TOKEN` | for comment and message operations | Business API access token (`Access-Token` header) |
| `TIKTOK_BUSINESS_ID` | for comment and message operations | Default `business_id` (the business account's open_id) |
| `TIKTOK_CLIENT_KEY` | for `refresh_access_token` | App client key (can also be passed as `client_key`) |
| `TIKTOK_CLIENT_SECRET` | for `refresh_access_token` | App client secret. Env only, never an argument |
| `TIKTOK_REFRESH_TOKEN` | no | Default refresh token for `refresh_access_token` |
| `TIKTOK_TOOL_ALLOW_POST` | no | `1` lets **agent tools** post directly (`mode=direct`), comment and reply (see [Agent policy](#agent-policy)) |
| `TIKTOK_TOOL_ALLOW_ENGAGE` | no | `1` lets agent tools hide, unhide, like and unlike comments |
| `TIKTOK_TOOL_ALLOW_DM` | no | `1` lets agent tools `send_message` |

Each API needs only its own token. A run with only `TIKTOK_BUSINESS_ACCESS_TOKEN` can still use the comment and message
operations. The Open API operations then fail with `auth_error`, and the message names `TIKTOK_ACCESS_TOKEN`. The same
applies the other way round.

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can also take
`access_token`, which overrides the **Open API** token. Pass it from a secret and trust the plugin
(`--trust-plugin tiktok-api`). Business operations (comments, messages) always use
`TIKTOK_BUSINESS_ACCESS_TOKEN` and reject a node `access_token` with `invalid_input`, so a comment is never posted
from the wrong account.

## Quick Start
```bash
export TIKTOK_ACCESS_TOKEN=...
graphrt run tiktok-api/example.yaml --plugins .
```

## Usage
```yaml
- id: post
  type: tiktok-api.publish_video
  video_url: "https://media.example.com/clips/launch.mp4"
  post_title: "Launch day #fyp"
  privacy_level: SELF_ONLY
- id: reply
  type: tiktok-api.reply_to_comment
  video_id: "{{#start.video_id#}}"
  comment_id: "{{#start.comment_id#}}"
  text: "Thank you!"
```
- **List operations** return `data` and `next_cursor`. Pass `next_cursor` back as `cursor` to get the next page.
  `list_videos` returns at most 20 videos per page. `data` is always an array. If a response has no list under the
  expected key (`videos`, `comments`, `conversations`, `messages`), an empty or paging-only response is an empty page;
  one that carries other fields fails with `api_error` naming the fields it got (the key was probably renamed), so a
  changed response never looks like "no results". Use `api_request` to see the raw response.
- **List arguments:** `photo_urls` and `video_ids` take an array, a JSON array string, or a single plain string (one item).
- **`business_id`** (and `TIKTOK_BUSINESS_ID`) is trimmed; a blank value fails with `invalid_input`.
- **Reads sent as POST** (`list_videos`, `query_videos`, `get_creator_info`, `get_publish_status`) are retried after a
  5xx or network error like any read; they are never reported as a write with an unknown outcome.
- **Publishing modes:**
  - `publish_video`: `mode: direct` (the default) needs `privacy_level`. `mode: inbox` sends a draft that the creator
    finishes in the app; it takes only `video_url` (and `wait`). Post settings such as `post_title` or `privacy_level` fail
    with `invalid_input` instead of being dropped, because inbox drafts are captioned and configured in the TikTok app.
  - `publish_photos`: `mode: direct` or `mode: upload`.
  - With `wait: false` the operation returns the `publish_id` right away. Check it later with `get_publish_status`.
  - Any failure after init (timeout, `FAILED`, an error while polling) is **not retryable** and names the
    `publish_id`. The post may still go live, so check `get_publish_status` before publishing again. Brief API
    errors while polling are retried automatically.
- **Polling:** graphrt plugins can't receive webhooks. To react to new comments, run a workflow on a schedule that lists them.

## Agent policy
TikTok's [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) expect the
creator to see and agree to every post, so agent tools start without public writes. Workflow nodes are never limited.

| Operations | As an agent tool |
|------------|------------------|
| Profile, videos, creator info, `get_publish_status`, `list_comments`, `list_comment_replies`, `list_conversations`, `list_messages` | Always |
| `publish_video` with `mode=inbox`, `publish_photos` with `mode=upload` (drafts the creator finishes in the app) | Always |
| `publish_video` / `publish_photos` with `mode=direct` (the default), `create_comment`, `reply_to_comment` | Only with `TIKTOK_TOOL_ALLOW_POST=1` |
| `set_comment_hidden`, `set_comment_liked` | Only with `TIKTOK_TOOL_ALLOW_ENGAGE=1` |
| `send_message` | Only with `TIKTOK_TOOL_ALLOW_DM=1` |
| `delete_comment`, `refresh_access_token` | Never (node only) |
| `api_request` | GET only |

- `send_message` has no recipient allowlist: its recipient is a Business API conversation id, not a user id, and
  TikTok only lets the business answer within 48 hours of the user's last message, so it can only reach people who
  wrote to the account recently.
- A refused call fails with `permission_denied` and sends no request.

## Per-user tokens (multi-user agents)

Set `TIKTOK_API_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin tiktok-api`):

```yaml
tools: [tiktok-api/get_user_info]
tool_context:
  tiktok-api:
    access_token: "{{#start.tiktok_api_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a TikTok Login Kit (Open API) user access token of that user; Business API tools (comments, messages) are refused in this mode, since `TIKTOK_BUSINESS_ACCESS_TOKEN` and `TIKTOK_BUSINESS_ID` are hidden.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `TIKTOK_ACCESS_TOKEN`, `TIKTOK_BUSINESS_ACCESS_TOKEN`, `TIKTOK_BUSINESS_ID`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REFRESH_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, a privacy level the creator can't use, a missing `business_id`, `invalid_params`, `privacy_level_option_mismatch`, Business code 40002 |
| `auth_error` | Missing token (the message names the env var), `access_token_invalid`, OAuth `invalid_grant`/`invalid_client`, Business codes 40101–40199 |
| `permission_denied` | Agent tool call without its opt-in ([Agent policy](#agent-policy)); `scope_not_authorized`, `spam_risk_*`, `unaudited_client_*`, `url_ownership_unverified`, Business code 40001 |
| `rate_limited` | `rate_limit_exceeded`, HTTP 429, Business code 40100. Retried automatically for up to 60 s |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named. A failed publish (`FAILED`) is an `api_error` that includes TikTok's `fail_reason` and the `publish_id` |

TikTok's messages are kept, with the code and `log_id` / `request_id` for support requests.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.3.0
- **Behaviour change for agents:** direct posts (`publish_video` / `publish_photos` with `mode=direct`),
  `create_comment` and `reply_to_comment` need `TIKTOK_TOOL_ALLOW_POST=1` as agent tools; `set_comment_hidden` and
  `set_comment_liked` need `TIKTOK_TOOL_ALLOW_ENGAGE=1`; `send_message` needs `TIKTOK_TOOL_ALLOW_DM=1`;
  `delete_comment` is node only. Inbox drafts and workflow nodes are unchanged.

### 0.2.0
- **Breaking:** `publish_video` and `publish_photos` parameter `title` is now `post_title` (still sent to TikTok as `post_info.title`). graphrt takes `title` from every workflow node, so the old name was silently dropped on nodes (posts went out without a caption); tool calls that passed `title` must use `post_title`.

## License
Apache-2.0
