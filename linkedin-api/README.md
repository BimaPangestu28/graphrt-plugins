# linkedin-api

**Status:** beta · **ToS risk:** high. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

> **0.2.0 (behaviour change for agents):** agent tools may no longer post, comment or react by default. Creating or
> editing posts and comments needs `LINKEDIN_TOOL_ALLOW_POST=1`, reactions need `LINKEDIN_TOOL_ALLOW_ENGAGE=1`, and
> `delete_post` / `delete_comment` are node only. Workflow nodes are unchanged. See [Agent policy](#agent-policy).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the official **LinkedIn REST API**
(`https://api.linkedin.com/rest`). It publishes and manages posts as a member or an organization, uploads images,
and reads and writes comments and reactions. Every operation is a workflow node. Agent tools are limited by the
[agent policy](#agent-policy).

> **Warning:** LinkedIn's [API Terms of Use](https://www.linkedin.com/legal/l/api-terms-of-use) (section 3.1) forbid
> using the APIs "to automate posting on the LinkedIn Services", and the
> [User Agreement](https://www.linkedin.com/legal/user-agreement) (section 8.2) bars bots that post, comment, like
> or share. LinkedIn can revoke the app and restrict the member. Have a person write or approve **every** post,
> comment and reaction (for example a human approval step before the node), and don't let an agent post on its own.
> Agent tools can't post, comment or react unless you set the opt-ins in [Agent policy](#agent-policy); leave them
> unset. There is no more permissive official alternative. See
> [docs/tos-audit.md](../docs/tos-audit.md#linkedin-api).

## Features
- **Profile:** `get_userinfo` (OpenID Connect userinfo plus the member's `person_urn`)
- **Posts:** create (text, image or article link), read, list an organization's posts, edit text, delete
- **Images:** `upload_image` downloads an image from an https URL and uploads it to LinkedIn, returning an `image_urn` for `create_post`
- **Comments:** list (on a post, or replies on a comment), create, reply, edit, delete
- **Reactions:** add (LIKE, PRAISE, EMPATHY, INTEREST, APPRECIATION, ENTERTAINMENT), remove, list
- **`api_request`:** any other REST endpoint, restricted to `api.linkedin.com` (see the limits under Usage)
- Clear error kinds; tokens never appear in errors.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A LinkedIn developer app and a 3-legged OAuth **access token** (valid 60 days; refresh tokens are only issued to
  approved Marketing Developer Platform partners, so plan to re-authorize)
- Scopes:

| Area | Scopes | Access |
|------|--------|--------|
| `get_userinfo` | `openid`, `profile`, `email` | Self-serve ("Sign In with LinkedIn using OpenID Connect" product) |
| Member posts, comments, reactions | `w_member_social` | Self-serve ("Share on LinkedIn" product) |
| Organization posts, comments, reactions; reading posts, comments and reactions | `w_organization_social`, `r_organization_social`, `rw_organization_admin` | **Community Management API**, needs approval |

### Community Management API approval
Everything that acts as or reads an **organization** (Company Page), and reading posts, comments or reactions in
general, needs the Community Management API product. Request it in the LinkedIn Developer Portal (Products tab); LinkedIn
reviews the use case and requires a verified Company Page tied to the app. The member read scope
`r_member_social` is closed to new apps, so `get_post`, `list_organization_posts`, `list_comments` and
`list_reactions` only work for organization content once you're approved. The member must also hold an admin role
(e.g. ADMINISTRATOR or CONTENT_ADMINISTRATOR) on the organization to post or comment as it.

Without approval you can still: read your userinfo, and create/delete posts, comments and reactions as yourself
(`urn:li:person:...`).

### Messaging is not available
LinkedIn's messaging APIs are restricted to approved partners, so this plugin has no DM operations.

## Installation
```bash
graphrt plugin install ./linkedin-api
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `LINKEDIN_ACCESS_TOKEN` | yes | OAuth 2.0 access token |
| `LINKEDIN_AUTHOR_URN` | no | Default author/actor for posts, comments, reactions and image uploads: `urn:li:person:<sub>` (from `get_userinfo`) or `urn:li:organization:<id>` |
| `LINKEDIN_TOOL_ALLOW_POST` | no | `1` lets **agent tools** create and edit posts and comments (see [Agent policy](#agent-policy); LinkedIn's terms forbid automated posting) |
| `LINKEDIN_TOOL_ALLOW_ENGAGE` | no | `1` lets agent tools add and remove reactions |
| `LINKEDIN_VERSION` | no | API version header `Linkedin-Version`, `YYYYMM`, default `202611`. LinkedIn retires versions after about a year; an inactive one fails with `invalid_input` |

graphrt starts plugins with a clean environment, and only these variables are passed through. A node can also take
`access_token` to use another token. Pass it from a secret and trust the plugin (`--trust-plugin linkedin-api`).

## Quick Start
```bash
export LINKEDIN_ACCESS_TOKEN=...
graphrt run linkedin-api/example.yaml --plugins .
```

## Usage
```yaml
- id: image
  type: linkedin-api.upload_image
  image_url: "https://example.com/banner.png"
- id: post
  type: linkedin-api.create_post
  text: "We're hiring (remote)!"
  image_urn: "{{#image.data.image_urn#}}"
  image_alt_text: "Hiring banner"
- id: like
  type: linkedin-api.add_reaction
  target_urn: "{{#post.data.id#}}"
  reaction_type: PRAISE
```
- **URNs:** posts are `urn:li:share:...` or `urn:li:ugcPost:...`; comments are `urn:li:comment:(urn:li:activity:...,<id>)`.
  The plugin URL-encodes them for you.
- **Post text:** LinkedIn's "Little Text Format" reserves `\ | { } @ [ ] ( ) < > # * _ ~`. By default the plugin
  escapes them so text is posted literally (a plain `#tag` is shown as text, not a hashtag link). To send mentions or
  hashtags, set `little_text_format: true` and write the markup yourself, e.g. `{hashtag|\#|graphrt}`.
- **Comments:** `create_comment` with `parent_comment_urn` posts a reply. `update_comment`/`delete_comment` take the
  post (`target_urn`) and the comment id or full comment URN.
- **List operations** return `data` and `next_cursor` (a start offset). Pass `next_cursor` back as `cursor` for the next page.
- **`api_request`** takes no custom headers, so it cannot set `X-RestLi-Method`. Rest.li calls that need it
  (`PARTIAL_UPDATE`, `BATCH_*`, and some finders and deletes) fail through it; use the dedicated operations for those.
  As an agent tool it is GET-only; other methods only work from workflow nodes.
- **Deletes** (`delete_post` and `delete_comment`, both node only, and `remove_reaction`): when a delete is retried after a server error or
  network failure and the retry gets 404, the first attempt most likely went through, so the operation succeeds with
  `already_absent: true`. A 404 on the first attempt is still `not_found`.
- **Images:** `upload_image` accepts JPEG, PNG and GIF only. The URL and every redirect must be https on a public host
  (loopback, private and link-local addresses are refused).
- **Polling:** graphrt plugins can't receive webhooks. To react to new comments, run a workflow on a schedule that lists them.

## Agent policy
LinkedIn's API Terms forbid using the APIs "to automate posting", so agent tools start read-only. Workflow nodes are
never limited; put a human approval step before them.

| Operations | As an agent tool |
|------------|------------------|
| `get_userinfo`, `get_post`, `list_organization_posts`, `list_comments`, `list_reactions`, `upload_image` | Always |
| `create_post`, `update_post`, `create_comment` (including replies), `update_comment` | Only with `LINKEDIN_TOOL_ALLOW_POST=1` |
| `add_reaction`, `remove_reaction` | Only with `LINKEDIN_TOOL_ALLOW_ENGAGE=1` |
| `delete_post`, `delete_comment` | Never (node only) |
| `api_request` | GET only |

A refused call fails with `permission_denied` and sends no request. LinkedIn has no direct-message API in this plugin.

## Per-user tokens (multi-user agents)

Set `LINKEDIN_API_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin linkedin-api`):

```yaml
tools: [linkedin-api/get_userinfo]
tool_context:
  linkedin-api:
    access_token: "{{#start.linkedin_api_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a LinkedIn member access token (3-legged OAuth) of that user; `LINKEDIN_AUTHOR_URN` is hidden too, so tools that act as a member or organization need the `author`/`author_urn`/`owner_urn` argument (LinkedIn still checks that the token may act as it).
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments or URNs, missing author, HTTP 400/422, or an inactive `LINKEDIN_VERSION` (426 `NONEXISTENT_VERSION`) |
| `auth_error` | Missing, invalid, expired or revoked token (HTTP 401, serviceErrorCode 65600–65604) |
| `permission_denied` | Agent tool call without its opt-in ([Agent policy](#agent-policy)); missing scope, Community Management approval or organization role (HTTP 403, `ACCESS_DENIED`) |
| `rate_limited` | HTTP 429. On LinkedIn this usually means a **daily** app or member limit was hit, not a short burst: the brief automatic retries rarely help, and the limit resets at midnight UTC. Check usage in the Developer Portal (Analytics tab) |
| `not_found`, `api_error`, `network_error`, `cancelled` | As named |

Messages include LinkedIn's `serviceErrorCode` and `code` when present.

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it.

## Changelog
### 0.2.0
- **Behaviour change for agents:** `create_post`, `update_post`, `create_comment` and `update_comment` need
  `LINKEDIN_TOOL_ALLOW_POST=1` as agent tools, `add_reaction` and `remove_reaction` need
  `LINKEDIN_TOOL_ALLOW_ENGAGE=1`, and `delete_post` / `delete_comment` are node only. Workflow nodes are unchanged.

## License
Apache-2.0
