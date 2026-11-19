# brevo operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `brevo.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_account` | Account, plan and remaining credits |  |
| `list_contacts` | Contacts, newest first, filtered by list, segment, change date or an attribute | modified_since, created_since, list_ids, segment_id, filter, sort, cursor, limit |
| `get_contact` | One contact with attributes, lists and campaign statistics (last 90 days unless dates are given) | **identifier**, identifier_type, start_date, end_date |
| `create_contact` | Create a contact (email, ext_id or SMS attribute), optionally in lists; update_enabled updates an existing one (as an agent tool only when BREVO_TOOL_ALLOW_CONTACT_WRITES=1) | email, attributes, ext_id, email_blacklisted, sms_blacklisted, list_ids, update_enabled |
| `update_contact` | Update a contact's attributes, blocklist flags and lists (as an agent tool only when BREVO_TOOL_ALLOW_CONTACT_WRITES=1) | **identifier**, identifier_type, attributes, ext_id, email_blacklisted, sms_blacklisted, list_ids, unlink_list_ids |
| `delete_contact` | Delete a contact permanently | **identifier**, identifier_type |
| `list_lists` | Contact lists with subscriber counts | sort, cursor, limit |
| `get_list` | One list's details and campaign statistics | **list_id**, start_date, end_date |
| `list_list_contacts` | Contacts of one list | **list_id**, modified_since, sort, cursor, limit |
| `add_contacts_to_list` | Add existing contacts to a list by email, contact id or EXT_ID (one kind per call); returns success and failure (as an agent tool only when BREVO_TOOL_ALLOW_CONTACT_WRITES=1) | **list_id**, emails, ids, ext_ids |
| `send_transactional_email` | Send one email (HTML/text or a template with params) to up to 99 recipients per field (as an agent tool only when BREVO_TOOL_ALLOW_SEND=1) | sender_email, sender_name, sender_id, **to**, cc, bcc, reply_to_email, reply_to_name, subject, html_content, text_content, template_id, params, tags, attachments, email_headers, scheduled_at |
| `list_email_templates` | Transactional email templates (ids for template_id) | template_status, sort, cursor, limit |
| `list_email_events` | Delivery events of transactional emails (requests, delivered, opened, bounces, ...) in the last days (max 90) | email, event, message_id, template_id, days, start_date, end_date, sort, cursor, limit |
| `list_email_campaigns` | Email campaigns, filtered by type, status or send dates | campaign_type, status, statistics, start_date, end_date, exclude_html_content, sort, cursor, limit |
| `get_email_campaign` | One email campaign with its statistics | **campaign_id**, statistics, exclude_html_content |
| `send_campaign_now` | Send an email campaign to its lists immediately | **campaign_id** |
| `list_webhooks` | Webhooks (their auth and headers may hold secrets) | webhook_type |
| `get_webhook` | One webhook | **webhook_id** |
| `api_request` | Call any Brevo API v3 endpoint that has no dedicated operation, e.g. path "/senders". Only the API's own host is allowed. Agent tools may only read paths under /account, /contacts, /senders, /domains, /smtp/templates, /smtp/statistics, /smtp/blockedContacts, /emailCampaigns. | method, **path**, query, body |
