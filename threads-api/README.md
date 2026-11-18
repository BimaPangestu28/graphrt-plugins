# threads-api

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Threads API**
(`graph.threads.net`). It reads the account's profile and posts, publishes text, image, video and carousel threads,
moderates replies, and reads mentions and keyword search. Every operation is a workflow node and an agent tool.

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

graphrt starts plugins with a clean environment, and only this variable is passed through. A node can also take
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
  with that `container_id` to publish the same container. Re-running without it would create a second post.
- **Validation:** `text` is limited to 500 characters, `poll_options` to 2–4 entries and carousels to 2–20 items.
- **Token refresh (node only):** `refresh_access_token` is not offered to agents as a tool, so new tokens never
  reach an LLM. It exchanges the current token (at least 24 hours old and not expired)
  for a new 60-day token and returns `{access_token, token_type, expires_in}`. The plugin does not store it.
  Update `THREADS_ACCESS_TOKEN` yourself, for example from a scheduled workflow.
- **Polling:** graphrt plugins can't receive webhooks. To react to new replies or mentions, run a workflow on a
  schedule that lists them.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments (e.g. text over 500 characters) or Graph code 100 |
| `auth_error` | Missing, invalid or expired token (Graph 190/102, HTTP 401) |
| `permission_denied` | Missing permission (Graph 10, 200–299) |
| `rate_limited` | Throttling. Graph codes 4, 17, 32 and 613 are hourly app/user limits and are not retried (try again later); a plain HTTP 429 is retried automatically for up to 60 s |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## License
Apache-2.0
