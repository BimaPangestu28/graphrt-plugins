# whatsapp-web operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `whatsapp-web.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `login` | Open a visible browser window with the WhatsApp Web QR code and wait until it is scanned (WhatsApp > Linked devices > Link a device). Later runs reuse the saved session headlessly. | timeout_seconds |
| `get_status` | Report whether WhatsApp Web is logged_in, needs_login (QR code shown) or loading, plus today's send count. |  |
| `list_chats` | List chats from the top of the WhatsApp chat list: name, last message preview, time and unread count. | limit, unread_only |
| `search_chats` | Search chats and contacts by name or number with the WhatsApp search box; returns the matching chat and contact rows (each with `kind`), without section headers or message hits. | **query**, limit |
| `read_messages` | Read the last messages of a chat (by phone number or exact chat name): id, from_me, sender, time, text and delivery status. Opening a chat marks it as read on your phone. | phone, chat_name, limit |
| `send_message` | Send a text message from your personal WhatsApp to a phone number or an existing chat (exact name). Rate limited; confirms the message appears as sent. | phone, chat_name, **text** |
| `send_file` | Send a photo, video or document (local path inside WHATSAPP_WEB_ALLOWED_FILE_DIRS, or an https URL) with an optional caption to a phone number or an existing chat. | phone, chat_name, **file**, caption, as_document |
