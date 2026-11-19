# wablas operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `wablas.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_device_info` | The device's name, sender number, connection status, remaining quota and expiry date |  |
| `list_message_reports` | Sent and received messages with their status (pending, sent, read, cancel), newest first | phone, ref_id, status, date, message_id, cursor, limit |
| `send_message` | Send a WhatsApp text to one number (queued; paid from the device quota) (as an agent tool only when WABLAS_TOOL_ALLOW_SEND=1) | **phone**, **message**, ref_id |
| `send_image` | Send a WhatsApp image by URL to one number (as an agent tool only when WABLAS_TOOL_ALLOW_SEND=1) | **phone**, **image**, caption, ref_id |
| `send_document` | Send a WhatsApp document by URL to one number (as an agent tool only when WABLAS_TOOL_ALLOW_SEND=1) | **phone**, **document**, caption, ref_id |
| `send_video` | Send a WhatsApp video by URL to one number (as an agent tool only when WABLAS_TOOL_ALLOW_SEND=1) | **phone**, **video**, **caption**, ref_id |
| `cancel_message` | Cancel a pending message so it is not sent (as an agent tool only when WABLAS_TOOL_ALLOW_SEND=1) | **message_id** |
| `resend_message` | Send a failed or pending message again | **message_id** |
