# meta-api

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Meta Graph API**. It manages a
Facebook Page (posts, comments), an Instagram professional account (publishing, comment moderation), and
Messenger / Instagram Direct conversations. Every operation is a workflow node and an agent tool.

## Features
- **Facebook Page:** page info; list, create (text/link/scheduled/photo), edit and delete posts
- **Facebook comments:** list (with total count), reply, hide/unhide, delete, like/unlike
- **Instagram:**
  - Account info, media list and publishing quota.
  - Publish an image, reel, story or carousel. The plugin waits for processing.
  - Comments: list, list replies, reply, hide/unhide, delete.
- **Messaging:** list conversations (Messenger or Instagram), read messages, send text or attachments
- **`api_request`:** any other Graph endpoint, restricted to `graph.facebook.com`
- Retries rate limits (using Meta's regain-access estimate), and gives clear error kinds. Tokens never appear in errors.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Meta app with Facebook Login for Business and a **Page access token** for your Page
- An Instagram professional account linked to that Page, if you use the Instagram operations
- Permissions (App Review for use beyond your own test users):

| Area | Permissions |
|------|-------------|
| Page read | `pages_show_list`, `pages_read_engagement`, `pages_read_user_content` |
| Page posts | `pages_manage_posts` |
| Comments | `pages_manage_engagement` |
| Instagram | `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments` |
| Messenger | `pages_messaging`, `pages_manage_metadata` |
| Instagram Direct | `instagram_manage_messages` |

## Installation
```bash
graphrt plugin install ./meta-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `META_ACCESS_TOKEN` | yes | Page access token (from `GET /me/accounts` with a user token) |
| `META_PAGE_ID` | for Page/messaging operations | Default Page id |
| `META_IG_USER_ID` | for Instagram operations | Default Instagram account id (`GET /{page-id}?fields=instagram_business_account`) |
| `META_GRAPH_VERSION` | no | Graph API version, default `v26.0` |

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can also
take `access_token` to use another Page's token. Pass it from a secret and trust the plugin
(`--trust-plugin meta-api`).

## Quick Start
```bash
export META_ACCESS_TOKEN=... META_PAGE_ID=...
graphrt run meta-api/example.yaml --plugins .
```

## Usage
```yaml
- id: reply
  type: meta-api.reply_to_comment
  object_id: "{{#start.comment_id#}}"
  message: "Terima kasih! Cek DM ya."
- id: dm
  type: meta-api.send_message
  recipient_id: "{{#start.psid#}}"
  text: "Halo! Ada yang bisa kami bantu?"
```
- **List operations** return `data` and `next_cursor`. Pass `next_cursor` back as `cursor` to get the next page.
- **Polling:** graphrt plugins can't receive webhooks. To react to new comments or messages, run a workflow on a schedule that lists them.
- **Messaging rules:** you can send free-form messages only within 24 hours of the person's last message. After that, use `messaging_type: MESSAGE_TAG` with `tag: HUMAN_AGENT`, which needs the approved Human Agent permission. Meta removed the other message tags in 2026.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, a missing Page or IG id, or Graph code 100/506 |
| `auth_error` | Missing, invalid or expired token (Graph 190/102, HTTP 401) |
| `permission_denied` | Missing permission or task (Graph 10, 200–299, 368) |
| `rate_limited` | Graph throttling (4, 17, 32, 613, 80001+). Retried automatically for up to 60 s |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## License
Apache-2.0
