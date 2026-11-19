# microsoft-graph

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Microsoft Graph v1.0](https://learn.microsoft.com/en-us/graph/api/overview):
Outlook mail (list, read, search, send, drafts, replies, flags, moves), calendar events and directory users, as
the signed-in user. OneDrive files are the separate `onedrive` plugin and Teams is
[`microsoft-teams`](../microsoft-teams/).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
`send_mail` and `create_draft` take simple fields (to, cc, bcc, subject, body) that
[`lib/mail-message.mjs`](lib/mail-message.mjs) turns into Graph's message resource after checking the addresses;
the OAuth token URL follows `MICROSOFT_TENANT_ID` ([`lib/graph-tenant.mjs`](lib/graph-tenant.mjs)).

## Features
- **Users:** `get_me`, `list_users`, `get_user`
- **Mail reads:** `list_mail_folders`, `list_messages` (all folders; `$filter`, `$search`, `$orderby`),
  `list_folder_messages` (e.g. `inbox`), `get_message` (optionally as plain text)
- **Mail writes:** `send_mail`, `create_draft`, `send_draft` (node only), `reply_to_message` (reply or reply all),
  `update_message` (read state, categories, flag), `move_message`, `delete_message` (node only)
- **Calendar:** `list_calendars`, `list_events`, `calendar_view` (occurrences in a time range), `get_event`,
  `create_event` (no attendees), `update_event`, `delete_event` (node only)
- **`api_request`:** any other Graph endpoint (GET only for agents)

Lists follow `@odata.nextLink`: `next_cursor` is that URL; pass it back as `cursor`. Message lists return a short
set of fields by default (`select`); `get_message` returns the body. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Microsoft Entra ID app registration; a work, school or personal Microsoft account

## Installation
```bash
graphrt plugin install ./microsoft-graph
```

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `MICROSOFT_CLIENT_ID` | yes | Application (client) id |
| `MICROSOFT_CLIENT_SECRET` | yes | Client secret (required: the plugin uses a confidential client; public clients without a secret are not supported) |
| `MICROSOFT_REFRESH_TOKEN` | yes | Refresh token of the signed-in user (delegated, with `offline_access`) |
| `MICROSOFT_TENANT_ID` | for single-tenant apps | Tenant id or domain; default `common` |
| `MICROSOFT_GRAPH_TOOL_ALLOW_SEND` | no | `1` lets agent tools send mail, reply and update events |
| `MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST` | no | Comma-separated addresses or `@domain`s agent tools may send to |

A node can pass `access_token` (a Graph access token used as-is; needs `--trust-plugin microsoft-graph`).

### Getting the credentials
1. Entra admin center → **App registrations → New registration** (accounts in this directory, or any directory
   plus personal accounts for Outlook.com). Add a Web redirect URI, create a client secret.
2. **API permissions → Microsoft Graph → Delegated:** `User.Read`, `User.ReadBasic.All` (list users),
   `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `offline_access`.
3. Get a refresh token with the authorization-code flow
   (<https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow>) and set
   `MICROSOFT_REFRESH_TOKEN`. The plugin refreshes the access token itself and keeps a rotated refresh token in
   memory. App-only (client credentials) tokens use `/users/{id}/...` paths instead of `/me` and are not supported
   by these operations; pass such a token with `access_token` and use `api_request`.

**Pricing / limits:** included with Microsoft 365 / Outlook.com. Exchange Online limits sending (e.g. 10,000
recipients a day per mailbox) and Graph throttles per mailbox (about 10,000 requests per 10 minutes); 429s carry
Retry-After, which the plugin honours.

## Quick Start
```bash
graphrt run microsoft-graph/example.yaml --plugins .
```

## Usage
```yaml
- id: send
  type: microsoft-graph.send_mail
  to: ["ops@example.com"]
  subject: "Nightly report"
  body: "<p>All jobs passed.</p>"
  body_type: html
- id: hold
  type: microsoft-graph.create_event
  subject: Focus time
  start_date_time: "2026-12-01T09:00:00"
  start_time_zone: Asia/Jakarta
  end_date_time: "2026-12-01T11:00:00"
  end_time_zone: Asia/Jakarta
```
Addresses must be plain (`ada@example.com`, no display names). `send_mail` answers `null` data (Graph returns 202
with no body); look in Sent Items for the message.

## Agent policy
- Reads, `create_draft`, `update_message`, `move_message` and `create_event` (no attendees, so no invitations) are
  tools.
- `send_mail`, `reply_to_message` and `update_event` (attendees are notified) are tools only with
  `MICROSOFT_GRAPH_TOOL_ALLOW_SEND=1`.
- With `MICROSOFT_GRAPH_TOOL_RECIPIENT_ALLOWLIST` set, tool `send_mail` calls may only address listed recipients
  (to, cc and bcc), and tool `reply_to_message` and `update_event` calls are refused, because the recipients of a
  reply or of an event's update notices are not known before the call. Nodes are not limited by the allowlist.
- `send_draft`, `delete_message` and `delete_event` are node only (a draft's recipients are not checked).

## Errors
Graph errors are `{"error": {"code", "message"}}`: `InvalidAuthenticationToken` → `auth_error` (refreshed once),
`ErrorAccessDenied`/`Forbidden` → `permission_denied`, `ErrorItemNotFound` → `not_found`,
`ErrorInvalidRecipients`/`BadRequest` → `invalid_input`, 429 → `rate_limited`. A failed `send_mail` is never
retried after an unknown outcome: check Sent Items first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the recipient allowlist, address validation and the reply rule. Verified
live only with invalid credentials (`auth_error`).

## License
Apache-2.0
