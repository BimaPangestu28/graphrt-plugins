# zoom

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Zoom REST API v2](https://developers.zoom.us/docs/api/):
users, meetings (list, get, create, update; delete is node only), ended meetings with their instances and
participants, and cloud recordings. It authenticates as a Zoom **Server-to-Server OAuth** app.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). The
token request is in [`lib/zoom-token.mjs`](lib/zoom-token.mjs), because Zoom's `account_credentials` grant is not
one the layer's OAuth support sends. Agent-tool safety is in [`lib/zoom-tool-safety.mjs`](lib/zoom-tool-safety.mjs).

## Features
- **Users:** `get_me`, `list_users`, `get_user`
- **Meetings:** `list_meetings` (scheduled, live, upcoming, upcoming_meetings, previous_meetings), `get_meeting`,
  `create_meeting`, `update_meeting`, `delete_meeting` (node only)
- **Past meetings:** `get_past_meeting`, `list_past_meeting_instances` (instance UUIDs of recurring meetings),
  `list_past_meeting_participants` (paid plans)
- **Recordings:** `list_recordings` (per user, from/to at most one month apart), `get_meeting_recordings`
- **`api_request`:** any other endpoint. Agents may only GET an allowlist of read paths.

Lists return `next_cursor` (Zoom's `next_page_token`, valid 15 minutes); `limit` is `page_size` (default 30, max
300). Meeting UUIDs that start with `/` or contain `//` are double-encoded for you. Full reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Zoom account with permission to create a Server-to-Server OAuth app (an account admin, or a user given the
  role permission)

## Installation
```bash
graphrt plugin install ./zoom
```

## Configuration
| Env var | Purpose |
|---|---|
| `ZOOM_ACCOUNT_ID` | Account ID of the Server-to-Server OAuth app |
| `ZOOM_CLIENT_ID` | Client ID of the app |
| `ZOOM_CLIENT_SECRET` | Client secret of the app (redacted everywhere) |

The plugin POSTs `grant_type=account_credentials&account_id=...` to `https://zoom.us/oauth/token` with Basic
client ID and secret. The access token lasts an hour. It is cached in memory until a minute before it expires, and
dropped after any `auth_error`, so the next call gets a new one. A workflow node may pass its own OAuth
`access_token` instead (needs `--trust-plugin zoom`). It is sent as is.

### Getting the credentials
1. [Zoom App Marketplace](https://marketplace.zoom.us/) → **Develop** → **Build App** → **Server-to-Server OAuth**.
2. Copy the **Account ID**, **Client ID** and **Client Secret**.
3. Add scopes, for example `user:read:admin`, `meeting:read:admin` and `meeting:write:admin`, plus
   `cloud_recording:read:admin` and `report:read:admin`. The granular names are `user:read:user:admin`,
   `meeting:read:list_meetings:admin`, `meeting:write:meeting:admin`, `cloud_recording:read:list_user_recordings:admin`
   and so on. Then **activate** the app.

**Pricing and limits:** the API is free to call. Some data needs a paid plan: past meeting participants (Pro or
higher), and cloud recordings (a plan with cloud recording). Rate limits depend on the plan and on the endpoint
group (light, medium, heavy). A meeting can be updated at most 100 times a day. A 429 is `rate_limited`, and the
call is retried after Retry-After.

## Quick Start
```bash
ZOOM_ACCOUNT_ID=... ZOOM_CLIENT_ID=... ZOOM_CLIENT_SECRET=... graphrt run zoom/example.yaml --plugins .
```

## Usage
```yaml
- id: meeting
  type: zoom.create_meeting
  user_id: me
  topic: "Kickoff with {{#start.client#}}"
  start_time: "2026-12-01T09:00:00"
  timezone: Asia/Jakarta
  duration: 45
  waiting_room: true
- id: answer
  type: answer
  answer: "Join: {{#meeting.data.join_url#}}"
```
- `create_meeting` returns `join_url` (for participants) and, for nodes, `start_url` (starts the meeting as the
  host; treat it like a password).
- `update_meeting` returns no body (Zoom answers 204). Call `get_meeting` to see the result.
- `list_past_meeting_instances` gives the UUID of each occurrence. Pass it as `meeting_id` to
  `get_past_meeting`, `list_past_meeting_participants` or `get_meeting_recordings`.

## Agent policy
- Reads, `create_meeting` and `update_meeting` are tools. `create_meeting` offers no invitee, alternative-host or
  registrant fields, so it sends no emails. Share `join_url` yourself.
- `delete_meeting` is node only. Its reminder options email registrants and hosts.
- Tool results never contain `start_url` (host start link with a ZAK token), recording `download_url`,
  `play_url`, `share_url`, `download_access_token` or `token`, or any passcode field (`password`, `encrypted_password`,
  `h323_password`, `pstn_password`, `recording_play_passcode`). `join_url` is kept. Workflow nodes get the full
  response.
- `api_request` as a tool may only GET these paths, with the same fields removed:
  - `/users`, `/users/{id}`, `/users/{id}/(meetings|upcoming_meetings|recordings|webinars)`
  - `/meetings/{id}`, `/meetings/{id}/(recordings|polls|meeting_summary)` (not registrants: each has a personal join link)
  - `/past_meetings/{id}`, `/past_meetings/{id}/(participants|instances|polls|qa)`
  - `/report/users/{id}/meetings`, `/report/meetings/{id}`, `/report/meetings/{id}/participants`
  - `/webinars/{id}`, `/meeting_summaries`

  Endpoints such as `/users/{id}/token`, which returns a host ZAK token, are refused for agents. The path is
  decoded once before matching; encoded slashes or backslashes (`%2F`, `%5C`, `\`), paths that do not decode, and
  any `%` left in user or webinar ids are refused.

## Errors
Zoom errors are `{"code": <number>, "message": "..."}`. They map to kinds as follows:
- 401 and code 124 (invalid access token) → `auth_error`
- codes 1001, 3001 and 3301 (user, meeting or recording not found) → `not_found`
- code 300 and 400s → `invalid_input`
- 403 → `permission_denied` (often a missing scope)
- 429 → `rate_limited`

Token endpoint failures are `auth_error`, with Zoom's reason (e.g. `invalid_client`), or a retryable
`api_error` on 5xx. `create_meeting` is never retried after an unknown outcome. Check with `list_meetings`
(`meeting_type: upcoming`) first.

## Testing
```bash
npm test          # from the repo root
```
`test/` covers the following, all with fake fetches:
- the generated contract suite;
- the token flow: grant and Basic auth, caching, shared concurrent requests, expiry, invalidation after 401,
  node tokens, and error mapping and redaction;
- tool output stripping and the api_request allowlist;
- UUID double-encoding.

Not verified with a real Zoom account. The only live check was an invalid app, which gave `auth_error`.

## License
Apache-2.0
