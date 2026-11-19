# google-search-console operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-search-console.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_sites` | Properties the caller can access, with permission levels (siteOwner, siteFullUser, siteRestrictedUser, siteUnverifiedUser) |  |
| `get_site` | One property and the caller's permission level | **site_url** |
| `add_site` | Add a property to the caller's Search Console account (it still has to be verified) (as an agent tool only when GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES=1) | **site_url** |
| `delete_site` | Remove a property from the caller's Search Console account | **site_url** |
| `query_search_analytics` | Clicks, impressions, CTR and position from Google Search, grouped by dimensions (query, page, country, device, date, ...) over a date range, with filters | **site_url**, **start_date**, **end_date**, dimensions, search_type, dimension_filter_groups, aggregation_type, data_state, cursor, limit |
| `list_sitemaps` | Sitemaps submitted for the property (or listed in a sitemap index), with errors, warnings and last download | **site_url**, sitemap_index |
| `get_sitemap` | One sitemap's status, errors, warnings and content counts | **site_url**, **sitemap_url** |
| `submit_sitemap` | Submit (or resubmit) a sitemap for the property (as an agent tool only when GOOGLE_SEARCH_CONSOLE_TOOL_ALLOW_WRITES=1) | **site_url**, **sitemap_url** |
| `delete_sitemap` | Remove a sitemap from the property's sitemap report | **site_url**, **sitemap_url** |
| `inspect_url` | Google's index status of one URL: coverage, last crawl, canonical, mobile usability, rich results, AMP | **inspection_url**, **site_url**, language_code |
| `api_request` | Call any Google Search Console API endpoint that has no dedicated operation, e.g. path "/webmasters/v3/sites". Only the API's own host is allowed. | method, **path**, query, body |
