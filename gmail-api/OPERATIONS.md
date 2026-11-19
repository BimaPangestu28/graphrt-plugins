# gmail-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `gmail-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_profile` | Address, message and thread totals and the current historyId |  |
| `list_messages` | Message ids matching a Gmail search (use get_message for content) | q, label_ids, include_spam_trash, cursor, limit |
| `get_message` | One message; format metadata with metadataHeaders is the cheapest way to read From/Subject | **message_id**, format, metadata_headers |
| `get_attachment` | Download a message attachment into $GMAIL_ATTACHMENT_DIR (attachment ids are in the message payload parts) | **message_id**, **attachment_id** |
| `send_message` | Send an email from the signed-in account (as an agent tool only when GMAIL_TOOL_ALLOW_SEND=1) | **to**, cc, bcc, reply_to, **subject**, text, html, thread_id, in_reply_to, references |
| `modify_message` | Add or remove labels on a message (mark read, star, archive) | **message_id**, add_label_ids, remove_label_ids |
| `trash_message` | Move a message to Trash (deleted after 30 days) | **message_id** |
| `list_threads` | Thread ids and snippets matching a Gmail search | q, label_ids, include_spam_trash, cursor, limit |
| `get_thread` | A thread with all its messages | **thread_id**, format, metadata_headers |
| `modify_thread` | Add or remove labels on every message of a thread | **thread_id**, add_label_ids, remove_label_ids |
| `list_labels` | System and user labels (ids for label_ids) |  |
| `get_label` | One label with message and thread counts | **label_id** |
| `create_label` | Create a user label | **name**, label_list_visibility, message_list_visibility |
| `list_drafts` | Draft ids | q, cursor, limit |
| `get_draft` | One draft with its message | **draft_id**, format |
| `create_draft` | Save a draft without sending it | to, cc, bcc, reply_to, subject, text, html, thread_id, in_reply_to, references |
| `send_draft` | Send an existing draft (its recipients are not checked against the allowlist) | **draft_id** |
| `api_request` | Call any Gmail API endpoint that has no dedicated operation, e.g. path "/history?startHistoryId=1". Only the API's own host is allowed. | method, **path**, query, body |
