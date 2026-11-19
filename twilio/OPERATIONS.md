# twilio operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `twilio.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `lookup_phone_number` | Free Lookup v2: validate and format a phone number (valid, E.164, national format, country) | **phone_number**, country_code |
| `lookup_phone_number_data` | Paid Lookup v2 data packages: line type, caller name, SIM swap, call forwarding, line status, reassigned number, SMS pumping risk (billed per package) (as an agent tool only when TWILIO_TOOL_ALLOW_LOOKUP=1) | **phone_number**, **fields**, country_code |
| `get_balance` | Current account balance and its currency |  |
| `send_sms` | Send an SMS or MMS (paid per segment; Twilio answers with the queued message) (as an agent tool only when TWILIO_TOOL_ALLOW_SEND=1) | **to**, body, messaging_service_sid, media_urls, content_sid, content_variables, validity_period_seconds, from |
| `send_whatsapp` | Send a WhatsApp message (free-form inside the 24-hour window, otherwise use content_sid with an approved template; paid) (as an agent tool only when TWILIO_TOOL_ALLOW_SEND=1) | **to**, body, messaging_service_sid, media_urls, content_sid, content_variables, validity_period_seconds, from |
| `list_messages` | Messages sent and received by the account, newest first | to, from, date_sent, date_sent_before, date_sent_after, page_size, cursor |
| `get_message` | One message with its status, price and error code | **message_sid** |
| `delete_message` | Delete a message record from the account logs | **message_sid** |
| `list_calls` | Voice calls of the account, newest first | to, from, status, start_time, start_time_before, start_time_after, page_size, cursor |
| `get_call` | One call with its status, duration and price | **call_sid** |
| `create_call` | Place an outbound voice call that runs TwiML from `url`, inline `twiml` or an application (paid per minute) | **to**, **from**, twiml_url, twiml, application_sid, ring_timeout_seconds, record |
| `api_request` | Call any Twilio REST API (2010-04-01 account resources) endpoint that has no dedicated operation, e.g. path "/Recordings.json". Only the API's own host is allowed. | method, **path**, query, body |
