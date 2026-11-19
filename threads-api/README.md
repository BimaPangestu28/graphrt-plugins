# threads-api

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

> **0.3.0 (behaviour change for agents):** agent tools may no longer publish, reply, repost or moderate replies by
> default. Publishing and reposts need `THREADS_TOOL_ALLOW_POST=1`, hiding and approving replies need
> `THREADS_TOOL_ALLOW_ENGAGE=1`, and `delete_thread` is node only. Workflow nodes are unchanged. See
> [Agent policy](#agent-policy).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Threads API**
(`graph.threads.net`). It reads the account's profile and posts, publishes text, image, video and carousel threads,
moderates replies, and reads mentions and keyword search. Every operation is a workflow node. Agent tools are limited by the
[agent policy](#agent-policy).

## Features
- **Profile:** own profile, public profile lookup by username, publishing quota, long-lived token refresh
- **Posts:** list threads and own replies, list mentions, keyword/topic-tag search, repost, delete
- **Publishing:** TEXT, IMAGE, VIDEO or CAROUSEL (2–20 items), as a reply or quote, with poll (2–4 options),
  link preview, topic tag, alt text and reply controls. The plugin waits for media processing.
- **Replies:** list top-level replies or the full conversation, hide/unhide, list and approve/ignore pending replies
- **`api_request`:** any other Threads endpoint (e.g. insights), restricted to `graph.threads.net`
- Retries rate limits, gives clear error kinds, and never puts tokens in errors.

Threads has no DM API, so the plugin has no messaging operations.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Meta app with the Threads use case, and a **long-lived Threads user access token** for your account
- Permissions (App Review for use beyond your own testers):

| Area | Permissions |
|------|-------------|
| Profile, own posts | `threads_basic` |
| Publish, repost | `threads_content_publish` |
| Read replies | `threads_read_replies` |
| Hide / approve replies | `threads_manage_replies` |
| Mentions | `threads_manage_mentions` |
| Keyword search | `threads_keyword_search` |
| Delete | `threads_delete` |
| Profile lookup | `threads_profile_discovery` |
| Insights (via `api_request`) | `threads_manage_insights` |

## Installation
```bash
graphrt plugin install ./threads-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `THREADS_ACCESS_TOKEN` | yes | Threads user access token (sent as a Bearer header) |
| `THREADS_TOOL_ALLOW_POST` | no | `1` lets **agent tools** publish posts, replies and quotes and repost (see [Agent policy](#agent-policy)) |
| `THREADS_TOOL_ALLOW_ENGAGE` | no | `1` lets agent tools hide, unhide, approve or ignore replies |

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can also take
`access_token` to use another account's token. Pass it from a secret and trust the plugin
(`--trust-plugin threads-api`).

## Quick Start
```bash
export THREADS_ACCESS_TOKEN=...
graphrt run threads-api/example.yaml --plugins .
```

## Usage
```yaml
- id: post
  type: threads-api.publish_thread
  text: "Rilis baru sudah live!"
  topic_tag: "graphrt"
  reply_control: "followers_only"
- id: carousel
  type: threads-api.publish_thread
  media_type: CAROUSEL
  text: "Behind the scenes"
  carousel_items: '[{"image_url":"https://example.com/1.jpg"},{"video_url":"https://example.com/2.mp4"}]'
- id: hide
  type: threads-api.hide_reply
  reply_id: "{{#start.reply_id#}}"
  hidden: true
```
- **List operations** return `data` and `next_cursor`. Pass `next_cursor` back as `cursor` to get the next page.
- **Publishing** creates a container, checks its status every 5 s (up to 6 minutes) until it is `FINISHED`,
  then publishes. `ERROR` or `EXPIRED` fails with `api_error` and the API's `error_message`. Text-only posts
  are checked the same way. The output is `{id, container_id}`. Carousel items are processed together, and the
  whole publish must finish within 6 minutes.
- **Safe retry:** if the final publish call fails, the error names the `container_id`. Run `publish_thread` again
  with `existing_container_id` set to that id to publish the same container. Re-running without it would create a second post.
- **Validation:** `text` is limited to 500 characters, `poll_options` to 2–4 entries and carousels to 2–20 items.
- **Token refresh (node only):** `refresh_access_token` is not offered to agents as a tool, so new tokens never
  reach an LLM. It exchanges the current token (at least 24 hours old and not expired)
  for a new 60-day token and returns `{access_token, token_type, expires_in}`. The plugin does not store it.
  Update `THREADS_ACCESS_TOKEN` yourself, for example from a scheduled workflow.
- **Polling:** graphrt plugins can't receive webhooks. To react to new replies or mentions, run a workflow on a
  schedule that lists them.

## Agent policy
Meta's Developer Policies require consent before publishing on someone's behalf, so agent tools start read-only.
Workflow nodes are never limited.

| Operations | As an agent tool |
|------------|------------------|
| Profiles, publishing limit, `list_threads`, `list_my_replies`, `list_mentions`, `keyword_search`, `list_replies`, `list_pending_replies` | Always |
| `publish_thread` (posts, replies with `reply_to_id`, quotes), `repost_thread` | Only with `THREADS_TOOL_ALLOW_POST=1` |
| `hide_reply`, `approve_pending_reply` | Only with `THREADS_TOOL_ALLOW_ENGAGE=1` |
| `delete_thread`, `refresh_access_token` | Never (node only) |
| `api_request` | GET only |

A refused call fails with `permission_denied` and sends no request. The Threads API has no direct messages.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments (e.g. text over 500 characters) or Graph code 100 |
| `auth_error` | Missing, invalid or expired token (Graph 190/102, HTTP 401) |
| `permission_denied` | Agent tool call without its opt-in ([Agent policy](#agent-policy)); missing permission (Graph 10, 200–299) |
| `rate_limited` | Throttling. Graph codes 4, 17, 32 and 613 are hourly app/user limits and are not retried (try again later); a plain HTTP 429 is retried automatically for up to 60 s |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.3.0
- **Behaviour change for agents:** `publish_thread` and `repost_thread` need `THREADS_TOOL_ALLOW_POST=1` as agent
  tools, `hide_reply` and `approve_pending_reply` need `THREADS_TOOL_ALLOW_ENGAGE=1`, and `delete_thread` is node
  only. Workflow nodes are unchanged.

### 0.2.0
- **Breaking:** `publish_thread` parameter `container_id` is now `existing_container_id`. graphrt takes `container_id` from every workflow node (it marks a node's parent container), so the old name could never be set from a node; tool calls that passed `container_id` must use `existing_container_id`. The output still reports `container_id`.

## License
Apache-2.0
