# google-analytics operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-analytics.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `run_report` | A GA4 report: dimensions x metrics over date ranges, with filters, sorting and totals | **property_id**, dimensions, **metrics**, dimension_filter, metric_filter, date_ranges, limit, offset, metric_aggregations, order_bys, currency_code, cohort_spec, keep_empty_rows, return_property_quota, comparisons |
| `run_realtime_report` | Events of the last 30 minutes (60 for Analytics 360), e.g. activeUsers by country | **property_id**, dimensions, **metrics**, dimension_filter, metric_filter, limit, metric_aggregations, order_bys, return_property_quota, minute_ranges |
| `run_pivot_report` | A pivot table report (pivots group dimensions into rows and columns) | **property_id**, dimensions, metrics, dimension_filter, metric_filter, date_ranges, **pivots**, currency_code, cohort_spec, keep_empty_rows, return_property_quota, comparisons |
| `batch_run_reports` | Up to 5 runReport requests in one call (each item like run_report's body in API field names) | **property_id**, **requests** |
| `get_metadata` | Every dimension and metric a property supports, with custom ones (property_id 0: only the common ones) | **property_id** |
| `check_compatibility` | Which dimensions and metrics can be combined with the given ones in run_report | **property_id**, dimensions, metrics, dimension_filter, metric_filter, compatibility_filter |
| `list_account_summaries` | Every account the caller can access with its properties (ids and names) | cursor, limit |
| `list_properties` | Properties under an account | **filter**, show_deleted, cursor, limit |
| `get_property` | A property's name, time zone, currency, industry and service level | **property_id** |
| `list_data_streams` | Web and app data streams of a property (measurement ids, app ids) | **property_id**, cursor, limit |
| `api_request` | Call any Google Analytics Data API endpoint that has no dedicated operation, e.g. path "/properties/<id>/metadata". Only the API's own host is allowed. | method, **path**, query, body |
