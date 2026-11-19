# vonage operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `vonage.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `number_insight` | Number Insight v1: basic (format, country; free), standard (+ carrier, ported) or advanced (+ validity, reachability, roaming); standard and advanced are billed per request (as agent tools only when VONAGE_TOOL_ALLOW_INSIGHT=1) | **level**, **number**, country, cnam |
| `get_balance` | Account balance in EUR and whether auto-reload is on |  |
| `send_sms` | Send an SMS (paid per segment; Vonage answers 202 with message_uuid) (as an agent tool only when VONAGE_TOOL_ALLOW_SEND=1) | **to**, **from**, **text**, ttl_seconds, encoding_type, client_ref |
| `send_whatsapp_text` | Send a WhatsApp text (only inside the 24-hour customer care window; paid) (as an agent tool only when VONAGE_TOOL_ALLOW_SEND=1) | **to**, **from**, **text**, client_ref |
| `send_whatsapp_image` | Send a WhatsApp image from a public URL (inside the 24-hour window; paid) (as an agent tool only when VONAGE_TOOL_ALLOW_SEND=1) | **to**, **from**, **image_url**, caption, client_ref |
| `send_whatsapp_template` | Send an approved WhatsApp message template, also outside the 24-hour window (paid per template category) (as an agent tool only when VONAGE_TOOL_ALLOW_SEND=1) | **to**, **from**, **template_name**, template_parameters, locale, client_ref |
| `send_whatsapp_custom` | Send any WhatsApp Cloud API message object (media/interactive templates, buttons, lists) as `custom` (paid) (as an agent tool only when VONAGE_TOOL_ALLOW_SEND=1) | **to**, **from**, **custom**, client_ref |
