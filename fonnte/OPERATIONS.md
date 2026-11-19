# fonnte operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `fonnte.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_device` | The device's number, connection status (connect/disconnect), package, remaining quota and expiry |  |
| `validate_numbers` | Check which numbers are registered on WhatsApp (needs a connected device) | **numbers** |
| `list_whatsapp_groups` | WhatsApp groups of the device as last fetched (id ...@g.us and name) |  |
| `send_message` | Send a WhatsApp message (text, or a file with caption) to one number; returns message ids and process status (as an agent tool only when FONNTE_TOOL_ALLOW_SEND=1) | **target**, message, file_url, filename, schedule, typing, connect_only, preview |
| `send_group_message` | Send a WhatsApp message to a group the device is in (id from list_whatsapp_groups) | **group_id**, message, file_url, filename, schedule, typing, connect_only, preview |
| `delete_message` | Delete a pending or scheduled message (not one that is processing) | **message_id** |
| `fetch_whatsapp_groups` | Re-fetch the device's group list from WhatsApp (Fonnte: call rarely, abuse can get the number banned) |  |
| `disconnect_device` | Log the WhatsApp number out of Fonnte (re-linking needs a QR scan) |  |
