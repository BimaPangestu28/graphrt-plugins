# mailchimp operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `mailchimp.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `ping` | Check the API key and data center (health_status) |  |
| `list_audiences` | Audiences (lists) with their stats | fields, exclude_fields, email, since_date_created, before_date_created, sort_dir, cursor, limit |
| `get_audience` | One audience with its settings and stats | **list_id**, fields, exclude_fields |
| `list_members` | Members of an audience, filtered by status or change date | **list_id**, fields, exclude_fields, status, since_last_changed, before_last_changed, vip_only, sort_field, sort_dir, cursor, limit |
| `get_member` | One member by email (or subscriber hash) | **list_id**, subscriber_hash, fields, exclude_fields, email |
| `search_members` | Find members by email or first/last name in one audience or all (exact_matches and full_search) | **query**, list_id, fields, exclude_fields |
| `upsert_member` | Add a member, or update them if the email is already in the audience (status_if_new applies to new members only) (as an agent tool only when MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES=1) | **list_id**, subscriber_hash, skip_merge_validation, email_address, status_if_new, status, merge_fields, email_type, language, vip, interests, tags, email |
| `list_member_tags` | Tags of one member | **list_id**, subscriber_hash, cursor, limit, email |
| `update_member_tags` | Add (status active) or remove (status inactive) tags on a member; tags may start automations unless is_syncing (as an agent tool only when MAILCHIMP_TOOL_ALLOW_MEMBER_WRITES=1) | **list_id**, subscriber_hash, **tags**, is_syncing, email |
| `archive_member` | Archive a member (they can be added back later) | **list_id**, subscriber_hash, email |
| `delete_member_permanently` | Erase a member and their data; they can never be re-imported | **list_id**, subscriber_hash, email |
| `list_campaigns` | Campaigns, filtered by type, status, audience or send/create time | fields, exclude_fields, campaign_type, status, list_id, since_send_time, before_send_time, since_create_time, before_create_time, sort_field, sort_dir, cursor, limit |
| `get_campaign` | One campaign: settings, recipients, status and send time | **campaign_id**, fields, exclude_fields |
| `get_campaign_content` | A campaign's HTML and plain-text content | **campaign_id**, fields, exclude_fields |
| `send_campaign` | Send a campaign to its whole audience now | **campaign_id** |
| `schedule_campaign` | Schedule a campaign to send at a quarter-hour UTC time | **campaign_id**, **schedule_time**, timewarp, batch_count, batch_delay |
| `unschedule_campaign` | Return a scheduled campaign to draft | **campaign_id** |
| `list_reports` | Reports of sent campaigns: opens, clicks, bounces, unsubscribes | fields, exclude_fields, campaign_type, since_send_time, before_send_time, cursor, limit |
| `get_report` | Report of one sent campaign | **campaign_id**, fields, exclude_fields |
| `list_audience_webhooks` | Webhooks of an audience (URLs may hold secrets) | **list_id** |
| `get_audience_webhook` | One audience webhook | **list_id**, **webhook_id** |
| `list_batch_webhooks` | Batch operation webhooks | cursor, limit |
| `api_request` | Call any Mailchimp Marketing API endpoint that has no dedicated operation, e.g. path "/lists/<list_id>/merge-fields". Only the API's own host is allowed. Agent tools may only read paths under /ping, /lists, /search-members, /campaigns, /campaign-folders, /reports, /templates, /template-folders except /lists/*/webhooks. | method, **path**, query, body |
