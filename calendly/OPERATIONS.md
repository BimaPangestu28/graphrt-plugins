# calendly operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `calendly.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | The token's user; data.uri and data.current_organization feed the user/organization filters |  |
| `get_user` | One user | **user_uuid** |
| `list_organization_memberships` | Members of an organization (or the memberships of one user) | organization, user, email, role, cursor, limit |
| `list_event_types` | Event types of a user or organization (set one of them) | user, organization, active, sort, cursor, limit |
| `get_event_type` | One event type with its scheduling_url, duration and questions | **event_type_uuid** |
| `list_available_times` | Open start times of an event type in a range of at most 7 days | **event_type**, **start_time**, **end_time** |
| `list_scheduled_events` | Booked events of a user or organization (set one of them), filtered by time, status or invitee email | user, organization, group, invitee_email, status, min_start_time, max_start_time, sort, cursor, limit |
| `get_scheduled_event` | One booked event with its location and invitee counts | **event_uuid** |
| `list_invitees` | Invitees of a scheduled event with their answers | **event_uuid**, status, email, sort, cursor, limit |
| `get_invitee` | One invitee of a scheduled event | **event_uuid**, **invitee_uuid** |
| `list_availability_schedules` | A user's availability schedules (working hours rules) | **user** |
| `list_busy_times` | A user's busy intervals (Calendly events and connected calendars) in a range of at most 7 days | **user**, **start_time**, **end_time** |
| `create_scheduling_link` | Create a booking link for one event of an event type (data.booking_url) (as an agent tool only when CALENDLY_TOOL_ALLOW_SCHEDULING_LINK=1) | **event_type** |
| `book_meeting` | Book an invitee into an open time of an event type (Calendly sends the usual confirmations and calendar invitations; paid plans) (as an agent tool only when CALENDLY_TOOL_ALLOW_BOOKING=1) | **event_type**, **start_time**, **invitee_email**, **invitee_timezone**, invitee_name, location, questions_and_answers, event_guests |
| `cancel_event` | Cancel a scheduled event (Calendly emails the invitees) | **event_uuid**, reason |
| `api_request` | Call any Calendly API endpoint that has no dedicated operation, e.g. path "/users/me". Only the API's own host is allowed. Agent tools may only read users, event types, scheduled events, invitees, availability and memberships (invitee cancel/reschedule links are removed). | method, **path**, query, body |
