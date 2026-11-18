# google-calendar operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-calendar.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_calendars` | List the calendars on the account's calendar list with id, name, time zone and access role, and whether agent tools may use each one. | min_access_role, show_hidden, limit, cursor |
| `query_free_busy` | Get busy intervals for up to 50 calendars in a time range. Per-calendar errors (e.g. notFound when not shared) are returned, not thrown. | calendar_ids, **time_min**, **time_max**, time_zone |
| `find_free_slots` | Find meeting slots of `duration_minutes` when every listed calendar is free, inside working hours (default Mon-Fri 09:00-17:00 in time_zone), with optional buffers around busy time. Range up to 62 days. | calendar_ids, **time_min**, **time_max**, **duration_minutes**, time_zone, working_hours, buffer_minutes, slot_step_minutes, max_slots, extra_busy |
| `list_events` | List events in a time range, optionally matching text `q`. Recurring events are expanded and sorted by start by default. | calendar_id, time_min, time_max, q, single_events, order_by, time_zone, show_deleted, private_properties, created_by_plugin, limit, cursor |
| `get_event` | Get one event with its times, attendees and their responses, Meet link and private properties. | calendar_id, **event_id**, time_zone |
| `create_event` | Create an event (timed or all-day) with optional guests, reminders and a Google Meet link. Pass idempotency_key to make retries safe; book_slot re-checks free/busy first and fails `conflict` if the time was taken or the key already booked another time. | calendar_id, summary, description, location, **start**, end, time_zone, attendees, reminders, use_default_reminders, recurrence, transparency, visibility, color_id, private_properties, add_google_meet, send_updates, idempotency_key, event_id, book_slot |
| `update_event` | Change some fields of an event (PATCH): only the given fields change; `attendees` replaces the whole guest list. Agent tools may only update events this plugin created. | calendar_id, **event_id**, summary, description, location, start, end, time_zone, attendees, reminders, use_default_reminders, recurrence, transparency, visibility, color_id, private_properties, add_google_meet, send_updates |
| `delete_event` | Delete an event. Deleting one that is already deleted succeeds. Agent tools may only delete events this plugin created. | calendar_id, **event_id**, send_updates |
| `quick_add` | Create an event from text, e.g. "Lunch with Sari tomorrow 12:30-13:30 at Kopi Kenangan". Not retried after an unknown outcome. | calendar_id, **text**, send_updates |
| `api_request` | Call any Google Calendar API endpoint that has no dedicated operation, e.g. path "/colors". Only the API's own host is allowed. | method, **path**, query, body |
