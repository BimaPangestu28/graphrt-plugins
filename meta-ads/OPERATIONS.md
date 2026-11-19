# meta-ads operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `meta-ads.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_ad_accounts` | Ad accounts the token's user or system user can access | fields, cursor, limit |
| `get_ad_account` | An ad account's name, status, currency (budgets use its minor units), time zone and spend | **ad_account_id**, fields |
| `list_campaigns` | Campaigns of an ad account (archived and deleted ones only when effective_status asks for them) | **ad_account_id**, fields, effective_status, filtering, cursor, limit |
| `list_ad_sets` | Ad sets of an ad account (archived and deleted ones only when effective_status asks for them) | **ad_account_id**, fields, effective_status, filtering, cursor, limit |
| `list_ads` | Ads of an ad account (archived and deleted ones only when effective_status asks for them) | **ad_account_id**, fields, effective_status, filtering, cursor, limit |
| `list_ad_creatives` | Ad creatives of an ad account (archived and deleted ones only when effective_status asks for them) | **ad_account_id**, fields, effective_status, filtering, cursor, limit |
| `get_campaign` | Get campaign: settings, status and budget | **campaign_id**, fields |
| `get_ad_set` | Get ad set: settings, status and budget | **ad_set_id**, fields |
| `get_ad` | Get ad: settings, status and budget | **ad_id**, fields |
| `get_insights` | Performance metrics (spend, impressions, clicks, actions...) of an ad account, campaign, ad set or ad, with date range, breakdowns and level. Use run_insights_report for large ranges or many rows | **object_id**, fields, date_preset, time_range, time_increment, level, breakdowns, action_breakdowns, action_attribution_windows, filtering, sort, use_unified_attribution_setting, cursor, limit |
| `run_insights_report` | Start an asynchronous insights report (for large date ranges, many objects or breakdowns) and wait until it is done; then read the rows with get_insights_report_rows and the report_run_id (wait: false returns at once) | **object_id**, fields, date_preset, time_range, time_increment, level, breakdowns, action_breakdowns, action_attribution_windows, filtering, sort, use_unified_attribution_setting, wait |
| `get_insights_report_rows` | Rows of a finished async insights report (report_run_id from run_insights_report; kept for 30 days) | **report_run_id**, cursor, limit |
| `list_lead_forms` | Instant Forms (lead forms) of a Facebook Page: ids, names, status and leads count (may need a Page access token as the node's access_token) | **page_id**, fields, cursor, limit |
| `list_leads` | Leads (form answers: personal data) of a lead form or of an ad, optionally created after a time (as an agent tool only when META_ADS_TOOL_ALLOW_LEADS=1) | **lead_source_id**, fields, filtering, cursor, limit |
| `set_status` | Pause or activate a campaign, ad set or ad (archiving and deleting are node only: delete_object) (as an agent tool only when META_ADS_TOOL_ALLOW_WRITES=1) | **object_id**, **status**, object_type |
| `set_budget` | Change the daily or lifetime budget of a campaign (campaign budget) or ad set, in the account currency's minor units. Agent tools also need META_ADS_TOOL_MAX_DAILY_BUDGET (as an agent tool only when META_ADS_TOOL_ALLOW_WRITES=1) | **object_id**, daily_budget, lifetime_budget, object_type |
| `create_campaign` | Create a campaign (PAUSED by default) | **ad_account_id**, **name**, **objective**, **special_ad_categories**, status, daily_budget, lifetime_budget, bid_strategy, spend_cap, execution_options |
| `create_ad_set` | Create an ad set in a campaign (PAUSED by default) | **ad_account_id**, **name**, **campaign_id**, status, daily_budget, lifetime_budget, billing_event, optimization_goal, bid_amount, targeting, promoted_object, start_time, end_time, execution_options |
| `create_ad_creative` | Create an ad creative | **ad_account_id**, name, object_story_spec, object_story_id, asset_feed_spec, degrees_of_freedom_spec, url_tags, execution_options |
| `create_ad` | Create an ad in an ad set from a creative (PAUSED by default) | **ad_account_id**, **name**, **adset_id**, **creative**, status, tracking_specs, execution_options |
| `delete_object` | Delete a campaign, ad set or ad (its children stop delivering; it cannot be undone) | **object_id** |
| `api_request` | Call any Meta Marketing API endpoint that has no dedicated operation, e.g. path "/act_<id>/adrules_library". Only the API's own host is allowed. | method, **path**, query, body |
