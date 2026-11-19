# tiktok-ads operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `tiktok-ads.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_advertiser_info` | Name, status, currency (budgets are in it), time zone, balance and company of ad accounts | **advertiser_ids**, fields |
| `list_campaigns` | Campaigns of an advertiser | **advertiser_id**, fields, filtering, cursor, limit |
| `list_ad_groups` | Ad groups of an advertiser | **advertiser_id**, fields, filtering, cursor, limit |
| `list_ads` | Ads of an advertiser | **advertiser_id**, fields, filtering, cursor, limit |
| `get_report` | Synchronous report: metrics by dimensions for an advertiser, campaign, ad group or ad level and a date range (365 days max; 30 with stat_time_day, 1 with stat_time_hour) | **advertiser_id**, report_type, data_level, **dimensions**, metrics, start_date, end_date, query_lifetime, filtering, order_field, order_type, enable_total_metrics, cursor, limit |
| `list_lead_forms` | Instant Forms (lead generation pages) of an advertiser: page_id, title and status | **advertiser_id**, status, form_title, cursor, limit |
| `get_lead_form_fields` | The questions (fields) of an Instant Form | **advertiser_id**, lead_source, page_id |
| `get_lead` | A lead of an Instant Form or a direct-message lead: answers (personal data) and campaign/ad metadata. For every lead of a form use create_lead_download_task (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_LEADS=1) | **advertiser_id**, lead_source, page_id |
| `create_lead_download_task` | Start (or, with task_id, check) an export of every lead of an Instant Form or an ad; when status is SUCCEED, download_leads returns the file (ad account admins only) (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_LEADS=1) | **advertiser_id**, page_id, ad_id, task_id, lead_region |
| `set_campaign_status` | Enable or disable campaigns (deleting is node only) (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_WRITES=1) | **advertiser_id**, **campaign_ids**, **operation_status** |
| `set_ad_group_status` | Enable or disable ad groups (deleting is node only) (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_WRITES=1) | **advertiser_id**, **adgroup_ids**, **operation_status** |
| `set_ad_status` | Enable or disable ads (deleting is node only) (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_WRITES=1) | **advertiser_id**, **ad_ids**, **operation_status** |
| `set_campaign_budget` | Change a campaign's budget, in the account currency's units (e.g. 50.5 = USD 50.50; at least 105% of what it has spent). Agent tools also need TIKTOK_ADS_TOOL_MAX_BUDGET (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_WRITES=1) | **advertiser_id**, **campaign_id**, **budget** |
| `set_ad_group_budgets` | Change lifetime budgets (budget, immediate) or schedule daily budgets (scheduled_budget, from 00:00 tomorrow) of up to 20 ad groups, in currency units. Agent tools also need TIKTOK_ADS_TOOL_MAX_BUDGET (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_WRITES=1) | **advertiser_id**, budget, scheduled_budget |
| `create_campaign` | Create campaign: the request body as in TikTok's docs, e.g. {"advertiser_id": "...", "campaign_name": "...", "objective_type": "TRAFFIC", "budget_mode": "BUDGET_MODE_DAY", "budget": 50} | **request_body** |
| `create_ad_group` | Create ad group: the request body as in TikTok's docs, e.g. {"advertiser_id": "...", "campaign_id": "...", "adgroup_name": "...", "placement_type": "PLACEMENT_TYPE_AUTOMATIC", ...} | **request_body** |
| `create_ad` | Create ad: the request body as in TikTok's docs, e.g. {"advertiser_id": "...", "adgroup_id": "...", "creatives": [...]} | **request_body** |
| `delete_campaigns` | Delete campaigns permanently (a deleted object can never be changed again) | **advertiser_id**, **campaign_ids** |
| `delete_ad_groups` | Delete ad groups permanently (a deleted object can never be changed again) | **advertiser_id**, **adgroup_ids** |
| `delete_ads` | Delete ads permanently (a deleted object can never be changed again) | **advertiser_id**, **ad_ids** |
| `api_request` | Call any TikTok API for Business endpoint that has no dedicated operation, e.g. path "/pixel/list/". Only the API's own host is allowed. | method, **path**, query, body |
| `download_leads` | Save the CSV or zip file of a finished lead download task into TIKTOK_ADS_LEADS_DIR (the file expires 10 minutes after it is ready) (as an agent tool only when TIKTOK_ADS_TOOL_ALLOW_LEADS=1) | **advertiser_id**, **task_id**, lead_region |
