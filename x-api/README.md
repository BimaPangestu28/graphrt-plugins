# x-api

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **X API v2**. It publishes and
manages posts, reads mentions and replies, likes and reposts, moderates replies, sends direct messages and uploads
images, all as the user who owns the OAuth 2.0 access token. Every operation is a workflow node and an agent tool.

> **Cost warning: X bills per request.** The X API is pay-per-use. Every read and every write is charged to your
> developer account, for example about $0.005 per post read, $0.010 per user or DM read, $0.015 per post created
> (more with a URL) and $0.015 per DM sent (X prices, November 2026; check the developer portal for current rates).
> Reads are billed per returned item, so a `limit` of 100 can cost 100 post reads. Keep `limit` small, don't poll
> on a tight schedule, and set a spending cap in the X developer portal. Agents that call these tools spend money.

## Features
- **Users:** the authenticated user, lookup by username
- **Posts:** create (text, reply, quote, up to 4 media, poll, reply settings), delete, read, list a user's posts,
  list mentions, recent search (last 7 days)
- **Replies and engagement:** list a conversation's replies, hide/unhide replies, like/unlike, repost/undo
- **Direct messages:** list DM events, read one conversation, send a DM (text and/or image), start a group DM
- **Media:** `upload_media` downloads an image from an https URL (up to 5 MB) and uploads it
- **Tokens:** `refresh_access_token`, which is node only and never offered to agents (X rotates refresh tokens, so the new one is returned)
- **`api_request`:** any other X API v2 endpoint, restricted to `api.x.com`
- Retries rate limits using `x-rate-limit-reset`, and gives clear error kinds. Tokens never appear in errors.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An X developer app with OAuth 2.0 enabled and pay-per-use credit
- A user access token from the OAuth 2.0 authorization-code flow with PKCE. App-only bearer tokens can only read
  public data and fail on user operations.
- Scopes:

| Area | Scopes |
|------|--------|
| Users, reading posts | `users.read`, `tweet.read` |
| Creating/deleting posts | `tweet.write` |
| Hiding replies | `tweet.moderate.write` |
| Likes | `like.read`, `like.write` |
| Reposts | `tweet.write` |
| Direct messages | `dm.read`, `dm.write` |
| Media upload | `media.write` |
| Refresh tokens | `offline.access` |

## Installation
```bash
graphrt plugin install ./x-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `X_ACCESS_TOKEN` | yes, except for `refresh_access_token` | OAuth 2.0 user access token (expires after 2 hours) |
| `X_USER_ID` | no | Your numeric user id. If it's unset, operations that need it (likes, reposts, your posts and mentions) call `GET /2/users/me` once per run, which is one extra billed user read. |
| `X_REFRESH_TOKEN` | no | Default refresh token for `refresh_access_token` |
| `X_CLIENT_ID` | no | Default OAuth 2.0 client id for `refresh_access_token` |
| `X_CLIENT_SECRET` | no | Client secret for confidential apps, used by `refresh_access_token` (Basic auth). Public PKCE apps leave it unset. |

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can also
take `access_token` to act as another account. Pass it from a secret and trust the plugin (`--trust-plugin x-api`).

## Quick Start
```bash
export X_ACCESS_TOKEN=...
graphrt run x-api/example.yaml --plugins .
```

## Usage
```yaml
- id: image
  type: x-api.upload_media
  image_url: "https://example.com/launch.png"
- id: post
  type: x-api.create_post
  text: "We just launched!"
  media_ids: ["{{#image.data.data.id#}}"]
- id: thanks
  type: x-api.send_dm
  participant_id: "{{#start.user_id#}}"
  text: "Thanks for the feedback!"
```
- **Output shape:** `data` is X's response body as returned. The resource is under `data.data`, expansions under
  `data.includes`, and partial errors under `data.errors`. A response with only `errors` and no `data` fails as an error.
- **Fields and expansions:** read operations take `query_params`, which is merged into the query string, e.g.
  `{"tweet.fields": "created_at,public_metrics", "expansions": "author_id", "user.fields": "username"}`.
  `query_params` can't override the operation's own parameters (`query`, `max_results`, cursors).
- **List operations** return `next_cursor`. Pass it back as `cursor` to get the next page. Each endpoint has its own
  `limit` range: 5–100 for user posts and mentions, 10–100 for search and replies, and 1–100 for DMs. The default
  is 10.
- **Replies** come from recent search on `conversation_id:`, so only replies from the last 7 days appear.
- **Quote posts:** X documents `quote_tweet_id` as restricted on some access levels. If your account isn't allowed
  to use it, the API rejects the request.
- **Polling:** graphrt plugins can't receive webhooks. To react to new mentions or DMs, run a workflow on a schedule,
  and remember that every poll is billed.
- **Token refresh (node only):** `refresh_access_token` takes `refresh_token` and `client_id`, or reads
  `X_REFRESH_TOKEN` and `X_CLIENT_ID`. It returns `access_token`, `refresh_token` and `expires_in`. Store the new
  refresh token, because the old one stops working. It isn't exposed as an agent tool, so tokens never reach an
  LLM.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments (ids, polls, limits, image URL/type/size), or X `invalid-request` |
| `auth_error` | Missing, invalid or expired token (HTTP 401, `unsupported-authentication`), or a rejected refresh token |
| `permission_denied` | Missing scope or access level (`client-forbidden`, `not-authorized-for-resource`), or a DM recipient that can't be messaged |
| `rate_limited` | HTTP 429, `usage-capped` or `dm-rate-limited`. It's retried automatically when `x-rate-limit-reset` is within 60 s, and `retryAfterMs` tells you when to try again. `usage-capped` (the monthly cap) is never retried |
| `not_found` | `resource-not-found` (also when X reports it in a 200 response) |
| `api_error`, `network_error`, `timeout`, `cancelled` | As named |

Writes (`POST`) are never retried on server or network errors, so a post or DM is never sent twice.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## License
Apache-2.0
