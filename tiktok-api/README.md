# tiktok-api

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **TikTok APIs**. It uses two of them:

- **Open API** (`open.tiktokapis.com`): profile, video list, Content Posting (video and photo posts) and token refresh.
- **Business API** (`business-api.tiktok.com/open_api/v1.3`): comments and direct messages of a TikTok business account.

Every operation is a workflow node and an agent tool.

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
  title: "Launch day #fyp"
  privacy_level: SELF_ONLY
- id: reply
  type: tiktok-api.reply_to_comment
  video_id: "{{#start.video_id#}}"
  comment_id: "{{#start.comment_id#}}"
  text: "Thank you!"
```
- **List operations** return `data` and `next_cursor`. Pass `next_cursor` back as `cursor` to get the next page.
  `list_videos` returns at most 20 videos per page.
- **Publishing modes:**
  - `publish_video`: `mode: direct` (the default) needs `privacy_level`. `mode: inbox` sends a draft that the creator finishes in the app.
  - `publish_photos`: `mode: direct` or `mode: upload`.
  - With `wait: false` the operation returns the `publish_id` right away. Check it later with `get_publish_status`.
  - Any failure after init (timeout, `FAILED`, an error while polling) is **not retryable** and names the
    `publish_id`. The post may still go live, so check `get_publish_status` before publishing again. Brief API
    errors while polling are retried automatically.
- **Polling:** graphrt plugins can't receive webhooks. To react to new comments, run a workflow on a schedule that lists them.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, a privacy level the creator can't use, a missing `business_id`, `invalid_params`, `privacy_level_option_mismatch`, Business code 40002 |
| `auth_error` | Missing token (the message names the env var), `access_token_invalid`, OAuth `invalid_grant`/`invalid_client`, Business codes 40101–40199 |
| `permission_denied` | `scope_not_authorized`, `spam_risk_*`, `unaudited_client_*`, `url_ownership_unverified`, Business code 40001 |
| `rate_limited` | `rate_limit_exceeded`, HTTP 429, Business code 40100. Retried automatically for up to 60 s |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named. A failed publish (`FAILED`) is an `api_error` that includes TikTok's `fail_reason` and the `publish_id` |

TikTok's messages are kept, with the code and `log_id` / `request_id` for support requests.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## License
Apache-2.0
