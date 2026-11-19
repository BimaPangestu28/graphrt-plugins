# google-calendar

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official **Google Calendar API v3**. Read
calendars and events, check availability, find free meeting slots, and create, change or delete events (with
Google Meet links). Every operation is a workflow node and an agent tool. Agent tools have extra limits (see
[Agent tool limits](#agent-tool-limits)).

## Features
- **Calendars and availability:** `list_calendars`, `query_free_busy`, and `find_free_slots`, which computes
  slots in the plugin from free/busy data, with working hours per weekday, IANA time zones (DST-correct), buffers
  and a slot step
- **Events:** `list_events` (time range, text search, recurring events expanded, paging), `get_event`,
  `create_event` (timed or all-day, guests, reminders, recurrence, Google Meet, private properties),
  `update_event` (PATCH), `delete_event`, `quick_add` (natural-language text)
- **Safe retries:** `create_event` sends its own event id. With `idempotency_key` the id is derived from the key,
  so a repeated create returns the existing event instead of a duplicate. `book_slot: true` re-checks free/busy
  right before creating and fails `conflict` if the time was taken
- **`api_request`:** any other Calendar API endpoint, restricted to `www.googleapis.com/calendar/v3`
- **Auth:** OAuth refresh token, service account key file, or a ready access token

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the **Google Calendar API** enabled
- Scope `https://www.googleapis.com/auth/calendar`

## Installation
```bash
graphrt plugin install ./google-calendar
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
Set **one** of these credential options.

| Env var | Description |
|---------|-------------|
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token for a Google account (authorize with `access_type=offline` and the calendar scope) |
| `GOOGLE_CLIENT_ID` | OAuth client id that issued the refresh token |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Path** to a service account JSON key file |
| `GOOGLE_ACCESS_TOKEN` | A ready OAuth access token (expires after about an hour) |

Agent tool limits (workflow nodes ignore them):

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_CALENDAR_TOOL_ALLOWED_IDS` | `primary` | Comma-separated calendar ids agent tools may use; `*` allows every calendar the credentials reach |
| `GOOGLE_CALENDAR_TOOL_SEND_UPDATES` | off | `1` lets agent tools email guests (`send_updates`); otherwise tools always send `none` |

- **Refresh trio:** the plugin exchanges the refresh token at `https://oauth2.googleapis.com/token`, caches the
  access token until a minute before it expires, and refreshes once when Calendar answers 401.
- **Service account:** the plugin signs an RS256 JWT with `node:crypto` and exchanges it at Google's token
  endpoint. `primary` is then the service account's own calendar: share your calendar with its `client_email`
  ("Make changes to events") and use your calendar id (your email address) instead of `primary`. Domain-wide
  delegation is not supported. Service accounts cannot invite guests without delegation, so use OAuth when
  events need attendees.
- **Precedence:** refresh trio, then service account. `GOOGLE_ACCESS_TOKEN` is used first when set, and a
  configured trio or service account takes over after a 401.
- A node can take `access_token` to use another account. That token is used as-is and is never refreshed. Pass it
  from a secret and trust the plugin (`--trust-plugin google-calendar`).

graphrt starts plugins with a clean environment, and only these variables are passed through.

## Quick Start
```bash
export GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
graphrt run google-calendar/example.yaml --plugins .
```

## Usage
```yaml
- id: slots
  type: google-calendar.find_free_slots
  calendar_ids: ["primary", "sari@example.com"]
  time_min: "2026-11-23"
  time_max: "2026-11-28"
  time_zone: "Asia/Jakarta"
  duration_minutes: 30
  buffer_minutes: 10
- id: book
  type: google-calendar.create_event
  summary: "Consultation with {{#start.customer#}}"
  start: "{{#slots.data.slots.0.start#}}"
  end: "{{#slots.data.slots.0.end#}}"
  attendees: ["{{#start.email#}}"]
  add_google_meet: true
  idempotency_key: "booking-{{#start.order_id#}}"
  book_slot: true
  send_updates: all
```
- **Times:** `start`/`end`/`time_min`/`time_max` take RFC 3339 with an offset (`2026-11-20T09:00:00+07:00`), a
  local date-time (`2026-11-20T09:00`) together with `time_zone`, or a date (`2026-11-20`). Dates in `start`/`end`
  make an all-day event; its `end` is exclusive and defaults to the next day. Offsets must lie within
  `-14:00`..`+14:00`. Event times are sent to Google as `YYYY-MM-DDTHH:MM:SS` plus the given offset (`Z` or
  `+07:00`, upper case): missing seconds become `:00` and fractional seconds are dropped.
- **`find_free_slots`:** `working_hours` maps weekdays to windows, e.g.
  `{"mon": ["09:00-12:00", "13:00-17:00"], "sat": ["10:00-14:00"]}` (default Mon-Fri 09:00-17:00); days left out
  have no slots, and `24:00` may end a window. Hours are wall-clock time in `time_zone` (default: the account's
  Calendar time zone setting), so 09:00 stays 09:00 across DST changes. A window start skipped by a DST change
  moves later by the gap (02:30 becomes 03:30); a window end skipped by one is clamped to where the gap ends
  (02:30 becomes 03:00), so no slot runs past the window. A repeated time resolves to its first occurrence. Slot starts sit on a `slot_step_minutes`
  grid (default 30) from each window's start. `buffer_minutes` keeps free time before and after busy time.
  Overlapping or touching busy intervals merge. Opaque all-day events are busy for the whole day, and
  `extra_busy` adds your own busy intervals (dates block whole local days). The range may span up to 62 days. If
  Google cannot read a calendar's free/busy (not shared: `notFound`), the operation fails rather than reporting
  that calendar as free.
- **`create_event` ids:** every insert carries its own event id, so the plugin retries a failed insert (5xx,
  network) with the same id, and a `409 duplicate` on a retry returns the event an earlier attempt made, with
  `already_existed: true`. Without `idempotency_key` that id is random per call: if the last attempt still fails
  with an unknown outcome, only that final error is not retryable (a new call would pick a new id and could
  duplicate the event), and it names the id to check with `get_event`. With a key the id is derived from it, so
  calling again is safe and that error stays retryable. The Meet `requestId` comes from the same id.
  `event_id` sets an explicit id (5-1024 characters of `a-v` and `0-9`).
- **`book_slot`** checks only the target calendar, and not atomically: two workflows booking the same slot at the
  same moment can both succeed. All-day events cannot use it. When the `idempotency_key` (or `event_id`) already
  has an event, the call returns it with `already_existed: true` only if it is at the requested start and end; if
  it sits at another time the call fails `conflict`, names that event and creates nothing (use a new key, or
  `update_event` to move it).
- **`update_event`** changes only the given fields. `attendees` replaces the whole guest list, `private_properties`
  are merged into the existing ones (an event created by this plugin always keeps `graphrt_created=1`), and
  changing `start` alone must keep it before the current `end`. Dates turn a timed event into an all-day one and
  date-times do the reverse: the plugin sends `date: null` or `dateTime: null, timeZone: null` for the other kind
  so Google never sees both. Each PATCH
  costs 3 quota units. Updates and quick adds are never retried after an unknown outcome.
- **`delete_event`** succeeds for an event that is already deleted (`already_deleted: true`).
- **`quick_add`** then tags the new event as created by this plugin (a second request, sending no emails). If
  tagging fails, the result has a `warning`, and agent tools cannot change that event.
- **Private properties:** stored only on this calendar's copy of the event. Filter with `list_events`
  `private_properties` or `created_by_plugin: true`.
- **Guest emails:** `send_updates` defaults to `none`. Use `all` or `externalOnly` to notify guests.

## Agent tool limits
When an LLM calls an operation as a tool:
- It may only use calendars in `GOOGLE_CALENDAR_TOOL_ALLOWED_IDS` (default `primary`). That includes the
  calendars in `query_free_busy` and `find_free_slots` and calendar paths in `api_request`. Ids are compared as
  text, so with the default, your email address is refused. Use `primary`.
- `send_updates` is forced to `none` unless `GOOGLE_CALENDAR_TOOL_SEND_UPDATES=1`, and the result says so
  (`notifications_suppressed`). Guests are still added to the event.
- `update_event` and `delete_event` only work on events this plugin created (private extended property
  `graphrt_created=1`, set on every `create_event` and `quick_add`). Deleting an event that is already cancelled
  reports `already_deleted: true` without the tag check.
- After that check the PATCH or DELETE carries `If-Match` with the event's etag, so a change made by someone else
  in between is never overwritten: the call fails `conflict` (HTTP 412). Read the event again and retry.
- `api_request` is GET-only.

## Quota
Calendar quotas are per project and per user per minute. Rate limits (`403 rateLimitExceeded`,
`userRateLimitExceeded`, `429`) are retried with backoff. The daily `quotaExceeded` is not retried.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad arguments, times, working hours or ids; HTTP 400 |
| `auth_error` | Missing, invalid or expired credentials, a rejected refresh token or service account key |
| `permission_denied` | No access to the calendar or event, the Calendar API is not enabled, or an agent tool limit |
| `not_found` | Unknown calendar or event, or free/busy `notFound` in `find_free_slots` |
| `conflict` | `book_slot` found the slot taken or its key already booked another time; an agent tool's update or delete raced another change (HTTP 412) |
| `already_exists` | The event id from `idempotency_key`/`event_id` belongs to an event that was deleted |
| `rate_limited` | Rate limits (retried) or the daily quota (not retried) |
| `api_error`, `network_error`, `timeout`, `cancelled` | As named. Writes whose outcome is unknown say how to check |

## Development
From the repo root: `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`. Don't edit it. `lib/google-auth.mjs`,
`lib/google-token-endpoint.mjs`, `lib/service-account.mjs` and `lib/google-errors.mjs` are kept identical to the
copies in `google-sheets/` and `google-business-profile-api/`. `lib/free-slots.mjs` and `lib/time-zones.mjs` are
pure and have their own tests.

## License
Apache-2.0
