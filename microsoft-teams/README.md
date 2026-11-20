# microsoft-teams

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Microsoft Teams through
[Microsoft Graph v1.0](https://learn.microsoft.com/en-us/graph/teams-concept-overview): joined teams, channels,
channel messages and replies, chats and chat messages, team and channel members, as the signed-in user.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs), plus
[`lib/graph-tenant.mjs`](lib/graph-tenant.mjs), which picks the OAuth token URL from `MICROSOFT_TENANT_ID`.

## Features
- **Teams:** `get_me`, `list_joined_teams`, `get_team`, `list_team_members`
- **Channels:** `list_channels`, `get_channel`, `list_channel_members`
- **Channel messages:** `list_channel_messages` (optionally with replies), `get_channel_message`,
  `list_message_replies`, `send_channel_message`, `reply_to_channel_message`
- **Chats:** `list_chats`, `get_chat`, `list_chat_messages`, `send_chat_message`
- **`api_request`:** any other Graph endpoint (GET only for agents)

Lists follow `@odata.nextLink`: `next_cursor` is that URL; pass it back as `cursor`. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Microsoft Entra ID app registration and a work or school account with Teams

## Installation
```bash
graphrt plugin install ./microsoft-teams
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `MICROSOFT_CLIENT_ID` | yes | Application (client) id |
| `MICROSOFT_CLIENT_SECRET` | yes | Client secret of the app registration |
| `MICROSOFT_REFRESH_TOKEN` | yes | Refresh token of the signed-in user (delegated, with `offline_access`) |
| `MICROSOFT_TENANT_ID` | for single-tenant apps | Tenant id or domain; default `common` (multi-tenant apps only) |
| `MICROSOFT_TEAMS_TOOL_ALLOW_SEND` | no | `1` lets agent tools send channel and chat messages |

A node can pass `access_token` (a Graph access token used as-is; needs `--trust-plugin microsoft-teams`).

### Why delegated auth
Graph allows **sending** Teams messages only with delegated permissions: `ChannelMessage.Send` for channels and
`ChatMessage.Send` for chats. The application permission `Teamwork.Migrate.All` can only import messages into
channels in migration mode. Reading channel messages app-only needs `ChannelMessage.Read.All`, a protected API
that Microsoft must approve. So the plugin uses the refresh-token grant of a signed-in user.

### Getting the credentials
1. Entra admin center → **App registrations → New registration**. Add a redirect URI (Web), e.g.
   `http://localhost:8400/callback`. Note the client id and tenant id; create a client secret.
2. **API permissions → Microsoft Graph → Delegated:** `User.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
   `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Chat.Read` (or `Chat.ReadWrite`), `ChatMessage.Send`,
   `TeamMember.Read.All`, `ChannelMember.Read.All`, `offline_access`. Several need **admin consent**.
3. Get a refresh token with the authorization-code flow
   (<https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow>), requesting the
   scopes above plus `offline_access`, and put it in `MICROSOFT_REFRESH_TOKEN`. The plugin refreshes the access
   token itself (scope `https://graph.microsoft.com/.default offline_access`) and keeps a rotated refresh token in
   memory for the process lifetime. Refresh tokens expire after 90 days without use.

**Pricing / limits:** included with Microsoft 365. Graph throttles per app and tenant, with
Teams-specific limits for message sends; a 429 carries Retry-After, which the plugin honours.

## Quick Start
```bash
graphrt run microsoft-teams/example.yaml --plugins .
```

## Usage
```yaml
- id: post
  type: microsoft-teams.send_channel_message
  team_id: "{{#start.team_id#}}"
  channel_id: "19:abc123@thread.tacv2"
  content: "<p>Deploy <b>done</b></p>"
  content_type: html
```

## Agent policy
- Reads are tools.
- `send_channel_message`, `reply_to_channel_message` and `send_chat_message` are tools only with
  `MICROSOFT_TEAMS_TOOL_ALLOW_SEND=1`.
- There are no delete or admin operations.

## Per-user tokens (multi-user agents)

Set `MICROSOFT_TEAMS_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin microsoft-teams`):

```yaml
tools: [microsoft-teams/get_me]
tool_context:
  microsoft-teams:
    access_token: "{{#start.microsoft_teams_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is a Microsoft identity platform access token for Microsoft Graph (delegated permissions) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_REFRESH_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
Graph errors are `{"error": {"code", "message"}}`: `InvalidAuthenticationToken` → `auth_error` (the plugin
refreshes once and retries), `Forbidden`/`AccessDenied` → `permission_denied`, `NotFound` → `not_found`,
`BadRequest` → `invalid_input`, 429 → `rate_limited`. Token endpoint failures (e.g. `invalid_grant`) are
`auth_error`. A failed send is never retried after an unknown outcome: check the channel or chat first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the tenant token URL, the refresh grant form and error mapping. Verified
live only with invalid credentials (`auth_error`).

## License
Apache-2.0
