# zoom operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `zoom.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | The user the app acts as (users/me) |  |
| `list_users` | Users of the account | status, role_id, cursor, limit |
| `get_user` | One user by id or email | **user_id** |
| `list_meetings` | A user's meetings: scheduled (default), live, upcoming, upcoming_meetings or previous_meetings | **user_id**, meeting_type, from, to, timezone, cursor, limit |
| `get_meeting` | One meeting with its settings and occurrences | **meeting_id**, occurrence_id, show_previous_occurrences |
| `create_meeting` | Schedule a meeting for a user (no invitations are sent; share join_url yourself) | **user_id**, **topic**, meeting_type, start_time, duration, timezone, agenda, passcode, recurrence, host_video, participant_video, join_before_host, mute_upon_entry, waiting_room, auto_recording |
| `update_meeting` | Change a meeting's topic, time, duration, agenda, passcode or settings (Zoom answers 204 with no body; 100 updates a day per meeting) | **meeting_id**, occurrence_id, topic, meeting_type, start_time, duration, timezone, agenda, passcode, recurrence, host_video, participant_video, join_before_host, mute_upon_entry, waiting_room, auto_recording |
| `delete_meeting` | Delete a meeting or one occurrence | **meeting_id**, occurrence_id, cancel_meeting_reminder, schedule_for_reminder |
| `get_past_meeting` | Details of an ended meeting (duration, participant count) | **meeting_id** |
| `list_past_meeting_instances` | Instances (UUIDs and start times) of an ended or recurring meeting | **meeting_id** |
| `list_past_meeting_participants` | Who joined an ended meeting, with join and leave times (paid plans) | **meeting_id**, cursor, limit |
| `list_recordings` | A user's cloud recordings between two dates (at most one month apart; default the last day) | **user_id**, from, to, meeting_id, cursor, limit |
| `get_meeting_recordings` | Cloud recording files of a meeting (latest instance for an id; one instance for a UUID) | **meeting_id** |
| `api_request` | Call any Zoom API endpoint that has no dedicated operation, e.g. path "/users/me/upcoming_meetings". Only the API's own host is allowed. Agent tools may only read users, meetings, past meetings, recordings and reports (start links, recording download links and passcodes are removed). | method, **path**, query, body |
