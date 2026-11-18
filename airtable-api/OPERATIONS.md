# airtable-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `airtable-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_bases` | List the Airtable bases the token can access (id, name, permission level), up to 1000 per page. | cursor |
| `get_base_schema` | Get a base's tables with their fields (names, ids, types, select options) and views. | base_id |
| `list_records` | List records of an Airtable table, optionally filtered by an Airtable formula, sorted, limited to a view or fields; one page at a time. | base_id, **table**, view, fields, limit, max_records, return_fields_by_field_id, cursor, filter_by_formula, sort |
| `find_records` | Find records whose fields equal (or contain) given values, e.g. where {"Email": "a@b.co"}. The formula is built with safe escaping; it is returned as `filter_by_formula`. | base_id, **table**, view, fields, limit, max_records, return_fields_by_field_id, cursor, **where**, match |
| `get_record` | Get one Airtable record by id. | base_id, **table**, **record_id** |
| `create_records` | Create up to 10 records: [{"fields": {...}}]. Never retried after an unknown outcome. | base_id, **table**, **records**, typecast |
| `update_records` | Update fields of up to 10 records by id (PATCH: other fields are kept): [{"id": "rec...", "fields": {...}}]. | base_id, **table**, **records**, typecast |
| `upsert_records` | Update or create up to 10 records, matched on 1-3 fields (e.g. Email): no match creates, one match updates, several fail. Every record needs a non-empty value for each merge field. | base_id, **table**, **records**, **fields_to_merge_on**, typecast |
| `delete_records` | Delete up to 10 records by id. Workflow node only (agents cannot delete). | base_id, **table**, **record_ids** |
| `api_request` | Call any Airtable API endpoint that has no dedicated operation, e.g. path "/meta/whoami". Only the API's own host is allowed. | method, **path**, query, body |
