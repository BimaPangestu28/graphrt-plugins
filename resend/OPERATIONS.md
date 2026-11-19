# resend operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `resend.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `send_email` | Send an email (html/text or a template), now or scheduled; returns the email id (as an agent tool only when RESEND_TOOL_ALLOW_SEND=1) | **from**, **to**, cc, bcc, reply_to, subject, html, text, template_id, template_variables, scheduled_at, tags, topic_id |
| `send_batch_emails` | Send up to 100 emails in one call (no attachments or scheduling); recipients are not checked | **emails** |
| `get_email` | One sent email with its html/text, recipients, last_event and scheduled_at (agent tools get html/text omitted) | **email_id** |
| `list_emails` | Emails your team sent, newest first | cursor, limit |
| `reschedule_email` | Change the send time of a scheduled email (as an agent tool only when RESEND_TOOL_ALLOW_SEND=1) | **email_id**, **scheduled_at** |
| `cancel_email` | Cancel a scheduled email before it is sent | **email_id** |
| `list_domains` | Sending domains with status, region and capabilities | cursor, limit |
| `get_domain` | One domain with its verification status and the DNS records to publish | **domain_id** |
| `api_request` | Call any Resend API endpoint that has no dedicated operation, e.g. path "/audiences". Only the API's own host is allowed. Agent tools may only read paths under /domains, /audiences, /contacts, /broadcasts, /templates, /topics, /segments. | method, **path**, query, body |
