# calendly

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Calendly API v2](https://developer.calendly.com/api-docs).
It covers the following:
- the current user, organization members, event types and their open times;
- scheduled events and their invitees;
- availability schedules and busy times;
- single-use scheduling links;
- booking an invitee (Scheduling API) and cancelling an event (node only).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Every
user, organization, event type, scheduled event and invitee reference can be a uuid or its API URI
(`https://api.calendly.com/users/<uuid>`). The plugin turns it into what each endpoint needs, and refuses URIs of
other hosts or collections ([`lib/calendly-resources.mjs`](lib/calendly-resources.mjs)).

## Features
- **Users:** `get_me` (its `uri` and `current_organization` feed the filters), `get_user`,
  `list_organization_memberships`
- **Event types:** `list_event_types`, `get_event_type`, `list_available_times` (open start times, at most 7 days)
- **Scheduled events:** `list_scheduled_events` (by user, organization or group; time range, status, invitee
  email), `get_scheduled_event`, `list_invitees`, `get_invitee`
- **Availability:** `list_availability_schedules`, `list_busy_times` (at most 7 days)
- **Writes:** `create_scheduling_link` (single-use booking link), `book_meeting`, `cancel_event` (node only)
- **`api_request`:** any other endpoint. Agents may only GET an allowlist of scheduling read paths.

Lists return `next_cursor` (Calendly's `pagination.next_page_token`); `limit` is `count` (default 20, max 100).
Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Calendly account. `book_meeting` needs a paid plan, and organization-wide lists need an admin or owner.

## Installation
```bash
graphrt plugin install ./calendly
```

## Configuration
| Env var | Purpose |
|---|---|
| `CALENDLY_ACCESS_TOKEN` | Personal access token, or an OAuth access token (redacted everywhere) |
| `CALENDLY_TOOL_ALLOW_SCHEDULING_LINK` | `1` lets agent tools create single-use scheduling links |
| `CALENDLY_TOOL_ALLOW_BOOKING` | `1` lets agent tools book meetings |

A workflow node may pass its own `access_token` instead (needs `--trust-plugin calendly`).

### Getting the credentials
In Calendly, open **Integrations & apps** → **API & webhooks** → **Personal access tokens**, then
**Generate new token**. The token acts as you. Newer tokens are scoped, so grant the scopes you need, for example
`users:read`, `event_types:read`, `scheduled_events:read`, `scheduled_events:write`, `availability:read` and
`scheduling_links:write`. For other users' accounts, register an OAuth app and pass its access token from a node.

**Pricing and limits:** the API is free with every Calendly plan. The Scheduling API (`book_meeting`) needs a
paid plan. Calendly rate-limits per token; a 429 is `rate_limited` and is retried after Retry-After.

## Quick Start
```bash
CALENDLY_ACCESS_TOKEN=... graphrt run calendly/example.yaml --plugins .
```

## Usage
```yaml
- { id: me, type: calendly.get_me }
- id: types
  type: calendly.list_event_types
  user: "{{#me.data.uri#}}"
  active: true
- id: link
  type: calendly.create_scheduling_link
  event_type: "{{#types.data.0.uri#}}"
- { id: answer, type: answer, answer: "Book here: {{#link.data.booking_url#}}" }
```
- `list_event_types` and `list_scheduled_events` need `user` or `organization`. The plugin refuses the call
  before any request when both are missing.
- To book: call `list_available_times` for an event type, then `book_meeting` with one of its `start_time` values.
  Also pass the invitee's email and time zone, and a `location` the event type offers. Calendly sends its usual
  confirmations and calendar invitations to the invitee and to any `event_guests`.

## Agent policy
- Reads are tools.
- `create_scheduling_link` needs `CALENDLY_TOOL_ALLOW_SCHEDULING_LINK=1` as a tool. An agent could otherwise hand
  out booking links to your calendar.
- `book_meeting` needs `CALENDLY_TOOL_ALLOW_BOOKING=1`, because it invites arbitrary email addresses.
- `cancel_event` is node only. Calendly emails every invitee about the cancellation.
- Tool results never contain invitee `cancel_url` or `reschedule_url`, because anyone who has those links can
  cancel or move the booking, nor the conferencing `password` in `location.data`. Nodes get them.
- `api_request` as a tool may only GET these paths (decoded once before matching; encoded `%2F`, `%5C`, `\` and
  paths that do not decode are refused), with the same fields removed:
  - users, event types, available times, event type memberships;
  - scheduled events and invitees, invitee no-shows;
  - availability schedules, busy times, meeting limits;
  - organization memberships, `/organizations/{uuid}`, groups, group relationships, locations;
  - routing forms and submissions.

  Webhook subscriptions (callback URLs), activity logs, data compliance, shares and organization invitations are
  refused.
- Writes are never retried after an unknown outcome. To check whether a booking was made, call
  `list_scheduled_events` with `invitee_email` first.

## Errors
Calendly errors are `{"title", "message", "details"}`. They are reported as `message (title)` and map to kinds
as follows:

| Title | Status | Kind |
|---|---|---|
| `Unauthenticated` | 401 | `auth_error` |
| `Permission Denied` | 403 | `permission_denied` |
| `Resource Not Found` | 404 | `not_found` |
| `Invalid Argument` | 400 | `invalid_input` |
| (any) | 429 | `rate_limited` |

## Testing
```bash
npm test          # from the repo root
```
`test/` has the following, all with fake fetches:
- the generated contract suite, with a case for every operation;
- tests for uuid and URI references, the owner check, tool link stripping, the opt-ins, the node-only cancel,
  the api_request allowlist and the error format.

Not verified with a real Calendly account. The only live check was an invalid token, which gave `auth_error`.

## License
Apache-2.0
