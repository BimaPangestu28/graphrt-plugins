# zoho-crm operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `zoho-crm.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_modules` | Modules of the org (api_name, plural_label, api_supported, ...) |  |
| `list_fields` | Fields of a module (api_name, data_type, picklist values, mandatory) | **module**, field_type |
| `list_related_lists` | Related lists of a module (api_name for list_related_records) | **module** |
| `list_users` | Users of the org | user_type, cursor, limit |
| `get_org` | The org's company details, time zone, currency and license |  |
| `list_records` | Records of a module (200 a page; next_cursor is the page_token) | **module**, **fields**, cvid, ids, sort_by, sort_order, converted, cursor, limit |
| `get_record` | One record by id | **module**, **record_id**, fields |
| `search_records` | Search a module by criteria, email, phone or word (one of them; at most 2,000 results; new records can take a moment to be searchable) | **module**, criteria, email, phone, word, converted, approved, cursor, limit |
| `coql_query` | Run a COQL SELECT, e.g. select Last_Name, Email from Leads where Lead_Status = 'Contacted' limit 0, 200 (max 2,000 rows a call; info.more_records) | **select_query** |
| `list_related_records` | Records in a related list of a record, e.g. Notes, Contacts or Deals of an Account | **module**, **record_id**, **related_list**, **fields**, sort_by, sort_order, cursor, limit |
| `insert_records` | Create up to 100 records; data[] reports each record's status (HTTP 207 when some failed) | **module**, **records**, trigger |
| `update_records` | Update up to 100 records; each needs its id (fields not given are kept) | **module**, **records**, trigger |
| `upsert_records` | Update records that match on duplicate-check fields, insert the rest (up to 100) | **module**, **records**, duplicate_check_fields, trigger |
| `delete_records` | Move up to 100 records to the recycle bin | **module**, **ids**, wf_trigger |
| `api_request` | Call any Zoho CRM API endpoint that has no dedicated operation, e.g. path "/settings/layouts?module=Leads". Only the API's own host is allowed. Agent tools may only read paths under /Leads, /Contacts, /Accounts, /Deals, /Tasks, /Events, /Calls, /Notes, /Products, /Quotes, /Sales_Orders, /Purchase_Orders, /Invoices, /Campaigns, /Vendors, /Price_Books, /Cases, /Solutions, /Appointments__s, /Services__s, /settings/modules, /settings/fields, /settings/layouts, /settings/related_lists, /settings/custom_views, /settings/pipeline, /users, /org. | method, **path**, query, body |
