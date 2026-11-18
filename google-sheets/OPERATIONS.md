# google-sheets operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-sheets.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_spreadsheet` | Get a spreadsheet's title, URL, locale and its sheets (tabs) with ids and sizes. | **spreadsheet_id** |
| `create_spreadsheet` | Create a new spreadsheet, optionally with named sheets. With a service account, the file belongs to the service account; share it to see it. | **title**, sheet_titles, locale, time_zone |
| `add_sheet` | Add a sheet (tab) to a spreadsheet. Fails with invalid_input if a sheet with that title exists. | **spreadsheet_id**, **title**, index, row_count, column_count |
| `read_range` | Read cell values from a range, e.g. sheet "Orders" with range "A1:D". Empty trailing rows and cells are omitted. | **spreadsheet_id**, sheet, range, major_dimension, value_render_option, date_time_render_option |
| `batch_read` | Read several ranges in one call. Each range is a full A1 range ('Sheet'!A1:C) or, with `sheet`, cells of that sheet. | **spreadsheet_id**, **ranges**, sheet, major_dimension, value_render_option, date_time_render_option |
| `append_rows` | Append rows after the last row of the table at `range` (default: the whole sheet). Never retried after an unknown outcome: check with read_range first. | **spreadsheet_id**, sheet, range, **rows**, value_input_option, insert_data_option |
| `update_range` | Overwrite cells starting at the top-left of `range` with `rows`. Cells outside `rows` are left unchanged. | **spreadsheet_id**, sheet, **range**, **rows**, value_input_option |
| `clear_range` | Clear the values (not the formatting) of `range`. To clear a whole sheet, pass `sheet` with `whole_sheet: true` (a missing or empty `range` is refused). Idempotent: safe to retry. | **spreadsheet_id**, sheet, range, whole_sheet |
| `find_rows` | Find rows in a sheet whose first row is the header. Filters compare trimmed text: equals, not_equals, contains, not_contains, is_empty, not_empty. Returns {row_number, record}. | **spreadsheet_id**, **sheet**, filters, match, case_sensitive, value_render_option, date_time_render_option, limit, cursor |
| `upsert_row` | Update the first row whose key column equals the record's key (formatted or unformatted value; only the record's columns change), or append the record as a new row. A text key is written verbatim. Not atomic: two concurrent upserts of a new key can both append, and rows inserted or deleted between the read and the write can shift the target row. | **spreadsheet_id**, **sheet**, **key_column**, **record**, value_input_option |
| `api_request` | Call any Google Sheets API endpoint that has no dedicated operation, e.g. path "/spreadsheets/{spreadsheet_id}/values/Sheet1!A1:B2". Only the API's own host is allowed. | method, **path**, query, body |
