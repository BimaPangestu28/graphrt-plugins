# x-api

**Status:** beta · **ToS risk:** medium. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

> **0.2.0 (behaviour change for agents):** agent tools may no longer post, reply, repost, like, hide replies or send
> DMs by default. Each group needs its own opt-in (`X_TOOL_ALLOW_POST`, `X_TOOL_ALLOW_ENGAGE`, `X_TOOL_ALLOW_DM`), DMs
> also need the recipient in `X_TOOL_RECIPIENT_ALLOWLIST`, and `delete_post` is node only. Workflow nodes are
> unchanged. See [Agent policy](#agent-policy).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **X API v2**. It publishes and
manages posts, reads mentions and replies, likes and reposts, moderates replies, sends direct messages and uploads
images, all as the user who owns the OAuth 2.0 access token. Every operation is a workflow node. Agent tools are
limited by the [agent policy](#agent-policy).

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
- **Media:** `upload_media` downloads an image from an https URL on a public host (up to 5 MB; every redirect hop must stay https and public) and uploads it
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
| `X_TOOL_ALLOW_POST` | no | `1` lets **agent tools** publish: `create_post` (posts, replies, quotes), `repost`, `undo_repost` |
| `X_TOOL_ALLOW_ENGAGE` | no | `1` lets agent tools `like_post`, `unlike_post` and `hide_reply` |
| `X_TOOL_ALLOW_DM` | no | `1` lets agent tools `send_dm` and `create_group_dm`, to recipients in `X_TOOL_RECIPIENT_ALLOWLIST` only |
| `X_TOOL_RECIPIENT_ALLOWLIST` | with `X_TOOL_ALLOW_DM` | Comma-separated user ids (and, for `send_dm` with `conversation_id`, conversation ids) agent tools may message, matched exactly. Unset refuses every agent DM |
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

## Agent policy
X's [Developer Policy](https://docs.x.com/developer-terms/policy) requires explicit consent before sending people
automated replies or DMs, so agent tools start read-only. Workflow nodes are never limited.

| Operations | As an agent tool |
|------------|------------------|
| Reads (`get_me`, users, posts, mentions, search, replies, DM events), `upload_media` | Always |
| `create_post` (posts, replies, quotes), `repost`, `undo_repost` | Only with `X_TOOL_ALLOW_POST=1` |
| `like_post`, `unlike_post`, `hide_reply` | Only with `X_TOOL_ALLOW_ENGAGE=1` |
| `send_dm`, `create_group_dm` | Only with `X_TOOL_ALLOW_DM=1` **and** every recipient in `X_TOOL_RECIPIENT_ALLOWLIST` |
| `delete_post`, `refresh_access_token` | Never (node only) |
| `api_request` | GET only |

- The allowlist holds exact ids: user ids for `participant_id` and `participant_ids` (every group member must be
  listed), and conversation ids for `send_dm` with `conversation_id` (e.g. `42-77`). An unset or empty allowlist
  refuses every agent DM, so the opt-in alone never lets an agent message strangers.
- A refused call fails with `permission_denied` and sends no request (and so costs nothing).
- Even with the opt-ins, X's [Automation Rules](https://help.x.com/en/rules-and-policies/x-automation) still apply:
  no keyword-triggered auto-replies, no automated posts about trending topics, no bulk or spammy actions.

## Per-user tokens (multi-user agents)

Set `X_API_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin x-api`):

```yaml
tools: [x-api/get_me]
tool_context:
  x-api:
    access_token: "{{#start.x_api_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an X OAuth 2.0 user access token of that user (the user id comes from `/2/users/me`; `X_USER_ID` is not used).
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `X_ACCESS_TOKEN`, `X_USER_ID`, `X_CLIENT_SECRET`, `X_REFRESH_TOKEN`, `X_CLIENT_ID` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments (ids, polls, limits, image URL/type/size), or X `invalid-request` |
| `auth_error` | Missing, invalid or expired token (HTTP 401, `unsupported-authentication`), or a rejected refresh token |
| `permission_denied` | Agent tool call without its opt-in or to a DM recipient outside the allowlist ([Agent policy](#agent-policy)); missing scope or access level (`client-forbidden`, `not-authorized-for-resource`), or a DM recipient that can't be messaged |
| `rate_limited` | HTTP 429, `usage-capped` or `dm-rate-limited`. It's retried automatically only when `x-rate-limit-reset` (or `Retry-After`) is known and within 60 s, since each retry is billed; and `retryAfterMs` tells you when to try again. `usage-capped` (the monthly cap) is never retried |
| `not_found` | `resource-not-found` (also when X reports it in a 200 response) |
| `api_error`, `network_error`, `timeout`, `cancelled` | As named |

Writes (`POST`) are never retried on server or network errors, so a post or DM is never sent twice.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.2.0
- **Behaviour change for agents:** publishing (`create_post`, `repost`, `undo_repost`) needs `X_TOOL_ALLOW_POST=1`,
  `like_post`, `unlike_post` and `hide_reply` need `X_TOOL_ALLOW_ENGAGE=1`, and `send_dm` / `create_group_dm` need
  `X_TOOL_ALLOW_DM=1` plus every recipient in `X_TOOL_RECIPIENT_ALLOWLIST`. `delete_post` is node only. Workflow
  nodes are unchanged.

## License
Apache-2.0
