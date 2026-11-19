# zerobounce operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `zerobounce.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `validate_email` | Validate one address: status (valid, invalid, catch-all, unknown, spamtrap, abuse, do_not_mail), sub_status, did_you_mean, domain age, MX (1 credit; unknown results are free) | **email**, ip_address, validation_timeout, activity_data, verify_plus |
| `validate_batch` | Validate up to 100 addresses in one call (can take up to 70 s; 1 credit each, unknown results free) (as an agent tool only when ZEROBOUNCE_TOOL_ALLOW_BATCH=1) | **email_batch**, validation_timeout, activity_data, verify_plus |
| `get_credits` | Remaining validation credits (free) |  |
| `get_api_usage` | API calls and result counts by status and sub_status between two dates (free) | **start_date**, **end_date** |
| `send_file` | Upload a CSV or TXT file for bulk validation (1 credit per address; return_url gets a POST when done) | **file**, **email_address_column**, first_name_column, last_name_column, gender_column, ip_address_column, has_header_row, remove_duplicate, allow_phase_2, return_url |
| `get_file_status` | Processing status and percentage of an uploaded file | **file_id** |
| `get_file` | Download the validation results of a finished file (CSV) into ZEROBOUNCE_OUTPUT_DIR | **file_id**, activity_data, download_type |
| `delete_file` | Delete an uploaded file and its results (only when its status is Complete) | **file_id** |
| `api_request` | Call any ZeroBounce API v2 endpoint that has no dedicated operation, e.g. path "/getcredits". Only the API's own host is allowed. Agent tools may only read paths under /getcredits, /getapiusage. | method, **path**, query, body |
