# telegram-bot operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `telegram-bot.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_updates` | Fetch new messages, button presses and other updates by long polling. Pass next_cursor back as cursor (or store it with state-store); it also confirms the updates already received. Fails while a webhook is set. | cursor, offset, limit, long_poll_seconds, allowed_updates |
| `send_message` | Send a text message to a chat, optionally formatted, as a reply, silent, or with an inline/reply keyboard. Never resent automatically. | **chat_id**, **text**, parse_mode, disable_link_preview, reply_to_message_id, disable_notification, protect_content, message_thread_id, reply_markup |
| `send_photo` | Send a photo by http(s) URL (Telegram downloads it, max 5 MB) or by file_id. Local files are not supported. | **chat_id**, **photo**, caption, parse_mode, reply_to_message_id, disable_notification, protect_content, message_thread_id, reply_markup, has_spoiler |
| `send_document` | Send a file by http(s) URL (Telegram downloads it, max 20 MB, PDF or ZIP only) or by file_id. Local files are not supported. | **chat_id**, **document**, caption, parse_mode, reply_to_message_id, disable_notification, protect_content, message_thread_id, reply_markup |
| `send_chat_action` | Show a status such as "typing…" in the chat for up to 5 seconds (until the bot's next message). | **chat_id**, action, message_thread_id |
| `edit_message_text` | Replace the text (and inline keyboard) of a message the bot sent, by chat_id + message_id or inline_message_id. | chat_id, message_id, inline_message_id, **text**, parse_mode, disable_link_preview, reply_markup |
| `delete_message` | Delete a message sent less than 48 h ago: the bot's own messages, incoming messages in private chats, or any message where the bot is an admin with delete rights. | **chat_id**, **message_id** |
| `forward_message` | Forward a message from one chat to another. Messages with protected content cannot be forwarded. | **chat_id**, **from_chat_id**, **message_id**, disable_notification, protect_content, message_thread_id |
| `answer_callback_query` | Answer an inline-keyboard button press (callback_query id from get_updates): show a short notification or alert, or stop the loading spinner. | **callback_query_id**, text, show_alert, url, cache_time |
| `get_me` | Return the bot's own user (id, username, name, capabilities). A quick way to check that the token works. |  |
| `get_chat` | Return up-to-date information about a chat (type, title, username, description, permissions) the bot can access. | **chat_id** |
| `get_chat_member_count` | Return the number of members in a group, supergroup or channel. | **chat_id** |
| `set_webhook` | Send the bot's updates to an https URL instead of get_updates. Sends TELEGRAM_WEBHOOK_SECRET (if set) as the X-Telegram-Bot-Api-Secret-Token header value. Node only. | **url**, max_connections, allowed_updates, drop_pending_updates, ip_address |
| `delete_webhook` | Remove the webhook so get_updates works again. Node only. | drop_pending_updates |
| `get_webhook_info` | Return the webhook URL (empty when using get_updates), pending update count and the last delivery error. Node only. |  |
| `api_request` | Call any Telegram Bot API method that has no dedicated operation, e.g. path "/getMyCommands" (GET with query) or "/setMyCommands" (POST with JSON body). Returns the method's result. | method, **path**, query, body |
