# google-ads operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-ads.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_accessible_customers` | Customer resource names (customers/<id>) the OAuth user can access directly |  |
| `search` | Run a GAQL SELECT query (attributes, segments, metrics of any resource), 10000 rows per page. PARAMETERS clauses are refused | **customer_id**, **query**, cursor |
| `search_stream` | Run a GAQL SELECT query and return every row at once as batches ([{results, fieldMask}]); for large exports prefer nodes | **customer_id**, **query** |
| `set_campaign_status` | Pause or enable a campaign (as an agent tool only when GOOGLE_ADS_TOOL_ALLOW_WRITES=1) | **customer_id**, **campaign_id**, **status**, validate_only |
| `set_ad_group_status` | Pause or enable an ad group (as an agent tool only when GOOGLE_ADS_TOOL_ALLOW_WRITES=1) | **customer_id**, **ad_group_id**, **status**, validate_only |
| `set_campaign_budget_amount` | Change a campaign budget's amount, in micros of the account currency (20000000 = 20.00). Agent tools also need GOOGLE_ADS_TOOL_MAX_DAILY_BUDGET_MICROS (as an agent tool only when GOOGLE_ADS_TOOL_ALLOW_WRITES=1) | **customer_id**, **budget_id**, **amount_micros**, validate_only |
| `mutate_campaigns` | Campaign mutate: create, update or remove operations, e.g. [{"create": {"name": "...", "status": "PAUSED", "campaignBudget": "customers/1/campaignBudgets/2", "advertisingChannelType": "SEARCH", "manualCpc": {}}}] | **customer_id**, **operations**, partial_failure, validate_only, response_content_type |
| `mutate_campaign_budgets` | Campaign budget mutate: create, update or remove operations, e.g. [{"create": {"name": "...", "amountMicros": "20000000", "deliveryMethod": "STANDARD"}}] | **customer_id**, **operations**, partial_failure, validate_only, response_content_type |
| `mutate_ad_groups` | Ad group mutate: create, update or remove operations, e.g. [{"remove": "customers/1/adGroups/3"}] | **customer_id**, **operations**, partial_failure, validate_only, response_content_type |
| `mutate_ad_group_ads` | Ad group ad mutate: create, update or remove operations, e.g. [{"update": {"resourceName": "customers/1/adGroupAds/3~4", "status": "PAUSED"}, "updateMask": "status"}] | **customer_id**, **operations**, partial_failure, validate_only, response_content_type |
| `mutate_ad_group_criteria` | Ad group criteria mutate: create, update or remove operations, e.g. [{"create": {"adGroup": "customers/1/adGroups/3", "keyword": {"text": "shoes", "matchType": "PHRASE"}}}] | **customer_id**, **operations**, partial_failure, validate_only, response_content_type |
| `mutate` | Multi-resource mutate: create, update or remove operations, e.g. [{"campaignOperation": {"update": {...}, "updateMask": "name"}}] | **customer_id**, **operations**, partial_failure, validate_only, response_content_type |
| `api_request` | Call any Google Ads API endpoint that has no dedicated operation, e.g. path "/customers:listAccessibleCustomers". Only the API's own host is allowed. | method, **path**, query, body |
| `get_campaign_performance` | Metrics per campaign (id, name, status, channel, budget) for a date range, highest cost first; removed campaigns are left out. Built on search; the GAQL sent is returned as data.query | **customer_id**, date_range, start_date, end_date, metrics, campaign_id, row_limit, cursor, daily |
| `get_keyword_performance` | Metrics per keyword (text, match type, status, ad group, campaign) for a date range, highest cost first; removed keywords are left out. Built on search; the GAQL sent is returned as data.query | **customer_id**, date_range, start_date, end_date, metrics, campaign_id, row_limit, cursor, ad_group_id |
| `get_search_terms` | Search queries that triggered ads (search term, whether it was added or excluded, ad group, campaign) with metrics, highest cost first. Built on search; the GAQL sent is returned as data.query | **customer_id**, date_range, start_date, end_date, metrics, campaign_id, row_limit, cursor, ad_group_id |
