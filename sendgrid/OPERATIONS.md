# sendgrid operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `sendgrid.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `send_mail` | Send an email (text/html or a dynamic template) to one set of recipients; accepted with 202 and no body (as an agent tool only when SENDGRID_TOOL_ALLOW_SEND=1) | **from**, from_name, **to**, cc, bcc, reply_to, subject, text, html, template_id, dynamic_template_data, categories, send_at, asm_group_id, sandbox_mode |
| `send_mail_raw` | Send a full mail/send body (many personalizations, attachments, tracking settings); recipients are not checked | **message** |
| `list_templates` | Transactional templates (dynamic by default) with their versions | generations, cursor, limit |
| `get_template` | One template with all its versions (subject, html and plain content, active flag) | **template_id** |
| `get_global_stats` | Account-wide counts per day/week/month: requests, delivered, opens, clicks, bounces, spam reports, unsubscribes | **start_date**, end_date, aggregated_by |
| `list_bounces` | Addresses on the bounce list, with the bounce reason and SMTP status | start_time, end_time, email, cursor, limit |
| `list_blocks` | Addresses whose receiving server blocked a message, with the reason | start_time, end_time, email, cursor, limit |
| `list_spam_reports` | Addresses that marked a message as spam | start_time, end_time, email, cursor, limit |
| `list_invalid_emails` | Addresses SendGrid found invalid, with the reason | start_time, end_time, email, cursor, limit |
| `list_global_unsubscribes` | Addresses that unsubscribed from all email | start_time, end_time, email, cursor, limit |
| `list_unsubscribe_groups` | Unsubscribe (suppression) groups with their unsubscribe counts; ids for send_mail asm_group_id |  |
| `api_request` | Call any SendGrid v3 API endpoint that has no dedicated operation, e.g. path "/categories". Only the API's own host is allowed. Agent tools may only read paths under /templates, /stats, /categories, /suppression, /asm, /messages, /verified_senders, /whitelabel/domains, /geo/stats, /devices/stats, /clients/stats, /mailbox_providers/stats, /browsers/stats. | method, **path**, query, body |
