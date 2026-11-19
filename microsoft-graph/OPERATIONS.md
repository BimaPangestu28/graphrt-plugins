# microsoft-graph operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `microsoft-graph.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | Profile of the signed-in user |  |
| `list_users` | Users of the organization (work accounts; needs User.ReadBasic.All) | filter, select, cursor, limit |
| `get_user` | One user by id or userPrincipalName | **user_id**, select |
| `list_mail_folders` | Top-level mail folders with item counts | cursor, limit |
| `list_messages` | Messages in all folders, or in one folder (well-known names: inbox, sentitems, drafts, archive) | filter, search, order_by, select, cursor, limit |
| `list_folder_messages` | Messages of one mail folder (id or well-known name such as inbox) | **folder_id**, filter, order_by, select, cursor, limit |
| `get_message` | One message with its body | **message_id**, select, body_format |
| `send_mail` | Send an email as the signed-in user (Graph answers 202 with no body) (as an agent tool only when MICROSOFT_GRAPH_TOOL_ALLOW_SEND=1) | **to**, cc, bcc, **subject**, **body**, body_type, importance, reply_to, save_to_sent_items |
| `create_draft` | Save a draft in Drafts without sending it | to, cc, bcc, subject, body, body_type, importance, reply_to |
| `send_draft` | Send an existing draft | **message_id** |
| `reply_to_message` | Reply to the sender (or everyone with reply_all) with a comment (as an agent tool only when MICROSOFT_GRAPH_TOOL_ALLOW_SEND=1) | **message_id**, **reply_kind**, **comment** |
| `update_message` | Mark read or unread, set categories or the follow-up flag | **message_id**, is_read, categories, flag_status |
| `move_message` | Move a message to another folder (the moved message gets a new id) | **message_id**, **destination_id** |
| `delete_message` | Move a message to Deleted Items | **message_id** |
| `list_calendars` | Calendars of the signed-in user | cursor, limit |
| `list_events` | Events of the default calendar as stored (recurring events appear once; use calendar_view for occurrences) | filter, order_by, select, cursor, limit |
| `calendar_view` | Event occurrences between two times (recurrences expanded), in UTC | **start_date_time**, **end_date_time**, order_by, select, cursor, limit |
| `get_event` | One event | **event_id**, select |
| `create_event` | Create an event in the default calendar, without attendees (so no invitation is sent) | **subject**, **start_date_time**, start_time_zone, **end_date_time**, end_time_zone, body, body_type, location, is_online_meeting, show_as |
| `update_event` | Change an event's subject, time, location or description (attendees are notified of changes) (as an agent tool only when MICROSOFT_GRAPH_TOOL_ALLOW_SEND=1) | **event_id**, subject, body, body_type, location, is_online_meeting, show_as, start_date_time, start_time_zone, end_date_time, end_time_zone |
| `delete_event` | Delete an event (attendees get a cancellation) | **event_id** |
| `api_request` | Call any Microsoft Graph endpoint that has no dedicated operation, e.g. path "/me/mailFolders/inbox". Only the API's own host is allowed. | method, **path**, query, body |
