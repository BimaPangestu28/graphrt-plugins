# meta-api

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

> **0.2.0 (behaviour change for agents):** agent tools may no longer publish, reply to comments, moderate or like
> comments, or send messages by default. Publishing and comment replies need `META_TOOL_ALLOW_POST=1`, hiding and
> liking comments need `META_TOOL_ALLOW_ENGAGE=1`, messages need `META_TOOL_ALLOW_DM=1` and the recipient in
> `META_TOOL_RECIPIENT_ALLOWLIST`, and deletes are node only. Workflow nodes are unchanged. See
> [Agent policy](#agent-policy).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **Meta Graph API**. It manages a
Facebook Page (posts, comments), an Instagram professional account (publishing, comment moderation), and
Messenger / Instagram Direct conversations. Every operation is a workflow node. Agent tools are limited by the
[agent policy](#agent-policy).

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
| `META_TOOL_ALLOW_POST` | no | `1` lets **agent tools** publish Page and Instagram posts and reply to comments (see [Agent policy](#agent-policy)) |
| `META_TOOL_ALLOW_ENGAGE` | no | `1` lets agent tools hide, unhide, like and unlike comments |
| `META_TOOL_ALLOW_DM` | no | `1` lets agent tools `send_message`, to recipients in `META_TOOL_RECIPIENT_ALLOWLIST` only |
| `META_TOOL_RECIPIENT_ALLOWLIST` | with `META_TOOL_ALLOW_DM` | Comma-separated PSIDs / IGSIDs agent tools may message, matched exactly. Unset refuses every agent message |

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

## Agent policy
Meta's [Developer Policies](https://developers.facebook.com/devpolicy) require consent before publishing on someone's
behalf and forbid spam, so agent tools start read-only. Workflow nodes are never limited.

| Operations | As an agent tool |
|------------|------------------|
| `get_page`, `list_page_posts`, `list_comments`, Instagram account, media, publishing limit and comment lists, `list_conversations`, `list_conversation_messages` | Always |
| `create_page_post`, `create_page_photo_post`, `update_page_post`, `reply_to_comment`, `publish_instagram_media`, `reply_to_instagram_comment` | Only with `META_TOOL_ALLOW_POST=1` |
| `set_comment_hidden`, `like_comment`, `unlike_comment`, `set_instagram_comment_hidden` | Only with `META_TOOL_ALLOW_ENGAGE=1` |
| `send_message` | Only with `META_TOOL_ALLOW_DM=1` **and** `recipient_id` in `META_TOOL_RECIPIENT_ALLOWLIST` |
| `delete_page_post`, `delete_comment`, `delete_instagram_comment` | Never (node only) |
| `api_request` | GET only |

- The allowlist holds exact page-scoped ids (PSIDs for Messenger, IGSIDs for Instagram); an unset or empty allowlist
  refuses every agent message, so the opt-in alone never lets an agent message arbitrary people.
- A refused call fails with `permission_denied` and sends no request.

## Per-user tokens (multi-user agents)

Set `META_API_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin meta-api`):

```yaml
tools: [meta-api/get_page]
tool_context:
  meta-api:
    access_token: "{{#start.meta_api_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Page access token of a Page that user manages (from `GET /me/accounts` with their user token); `META_PAGE_ID` and `META_IG_USER_ID` are hidden too, so pass `page_id` / `ig_user_id`.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `META_ACCESS_TOKEN`, `META_PAGE_ID`, `META_IG_USER_ID` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, a missing Page or IG id, or Graph code 100/506 |
| `auth_error` | Missing, invalid or expired token (Graph 190/102, HTTP 401) |
| `permission_denied` | Agent tool call without its opt-in or to a recipient outside the allowlist ([Agent policy](#agent-policy)); missing permission or task (Graph 10, 200–299, 368) |
| `rate_limited` | Graph throttling (4, 17, 32, 613, 80001+). Retried automatically for up to 60 s |
| `not_found`, `api_error`, `network_error`, `timeout`, `cancelled` | As named |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.2.0
- **Behaviour change for agents:** Page posts, Instagram publishing and comment replies need
  `META_TOOL_ALLOW_POST=1` as agent tools; hiding and liking comments need `META_TOOL_ALLOW_ENGAGE=1`;
  `send_message` needs `META_TOOL_ALLOW_DM=1` and the recipient in `META_TOOL_RECIPIENT_ALLOWLIST`. Deletes
  (`delete_page_post`, `delete_comment`, `delete_instagram_comment`) are node only. Workflow nodes are unchanged.

## License
Apache-2.0
