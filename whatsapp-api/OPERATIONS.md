# whatsapp-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `whatsapp-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `send_text` | Send a text message. Only allowed within 24 h of the recipient's last message; otherwise use send_template. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **body**, preview_url, reply_to_message_id, phone_number_id |
| `send_template` | Send an approved message template. Required for the first message and outside the 24 h window. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **name**, language, components, phone_number_id |
| `send_media` | Send an image, video, audio, document or sticker by public https link or uploaded media_id. 24 h window rules apply. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **media_type**, link, media_id, caption, filename, reply_to_message_id, phone_number_id |
| `send_location` | Send a location pin. 24 h window rules apply. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **latitude**, **longitude**, name, address, reply_to_message_id, phone_number_id |
| `send_interactive_buttons` | Send a message with up to 3 quick-reply buttons (title up to 20 characters). 24 h window rules apply. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **body**, **buttons**, header_text, footer, reply_to_message_id, phone_number_id |
| `send_interactive_list` | Send a list message: a button that opens up to 10 rows grouped in sections. 24 h window rules apply. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **body**, **button_text**, **sections**, header_text, footer, reply_to_message_id, phone_number_id |
| `send_reaction` | React to a message with an emoji, or remove your reaction. (as an agent tool only when WHATSAPP_TOOL_ALLOW_SEND=1 and the recipient is in WHATSAPP_TOOL_RECIPIENT_ALLOWLIST) | **to**, **message_id**, emoji, remove, phone_number_id |
| `mark_as_read` | Mark a received message (and earlier ones) as read, optionally showing a typing indicator. | **message_id**, show_typing_indicator, phone_number_id |
| `upload_media` | Download a file from a public https URL and upload it to WhatsApp; returns data.id for send_media. Limits: image 5 MB, video/audio 16 MB, document 100 MB, sticker 500 KB. | **url**, **media_type**, mime_type, filename, phone_number_id |
| `get_media_url` | Get the download URL, MIME type, size and sha256 of a media id. The URL expires after 5 minutes and needs the access token to download. | **media_id**, phone_number_id |
| `delete_media` | Delete uploaded media by id. | **media_id**, phone_number_id |
| `list_templates` | List the WABA's message templates, optionally filtered by status, name, category or language. | business_account_id, status, name, category, language, fields, limit, cursor |
| `get_template` | Read one message template by id (status, category, components). | **template_id**, fields |
| `create_template` | Submit a new message template for review. Components with parameters need example values. (as an agent tool only when WHATSAPP_TOOL_ALLOW_TEMPLATES=1) | business_account_id, **name**, **category**, **language**, **components**, parameter_format, allow_category_change |
| `delete_template` | Delete a template by name (all languages), or only one language version by name plus template_id. | business_account_id, **name**, template_id |
| `list_phone_numbers` | List the phone numbers on the WhatsApp Business Account with their display number, verified name and quality rating. | business_account_id, fields, limit, cursor |
| `get_business_profile` | Read the business profile (about, address, description, email, websites, vertical, picture) of a phone number. | phone_number_id, fields |
| `update_business_profile` | Change business profile fields of a phone number. Only the fields you pass are changed. (as an agent tool only when WHATSAPP_TOOL_ALLOW_PROFILE=1) | phone_number_id, about, address, description, email, websites, vertical, profile_picture_handle |
| `api_request` | Call any WhatsApp Cloud API (Graph) endpoint that has no dedicated operation, e.g. path "/{phone-number-id}". Only the API's own host is allowed. | method, **path**, query, body |
