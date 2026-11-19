# salesforce operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `salesforce.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_limits` | Daily API requests and other org limits with Max and Remaining |  |
| `describe_global` | Every sObject in the org (name, label, keyPrefix, queryable, createable, ...) |  |
| `describe_sobject` | Fields (types, picklist values, required), relationships and record types of an sObject | **sobject** |
| `query` | Run a SOQL query. Results come in batches (2,000 by default): when `done` is false, pass `nextRecordsUrl` to query_more | **soql** |
| `query_all` | Run a SOQL query that also returns deleted and archived records. Results come in batches (2,000 by default): when `done` is false, pass `nextRecordsUrl` to query_more | **soql** |
| `query_more` | The next batch of a query or query_all result | **query_locator** |
| `search` | Text search across objects with SOSL | **sosl** |
| `list_recently_viewed` | Records the user viewed or referenced most recently | max_records |
| `get_updated` | Ids of records of an sObject updated in a time range | **sobject**, **start**, **end** |
| `get_deleted` | Ids of records of an sObject deleted in a time range (still in the recycle bin) | **sobject**, **start**, **end** |
| `get_record` | One record by id | **sobject**, **record_id**, fields |
| `get_record_by_external_id` | One record by the value of an external id field | **sobject**, **external_id_field**, **external_id**, fields |
| `create_record` | Create a record; returns {id, success, errors} | **sobject**, **fields** |
| `update_record` | Update fields of a record (fields not given are kept); no content on success | **sobject**, **record_id**, **fields** |
| `upsert_record` | Create or update the record with this external id value (201 created, 200/204 updated) | **sobject**, **external_id_field**, **external_id**, **fields** |
| `delete_record` | Move a record to the recycle bin | **sobject**, **record_id** |
| `api_request` | Call any Salesforce REST API endpoint that has no dedicated operation, e.g. path "/sobjects/Account/listviews". Only the API's own host is allowed. | method, **path**, query, body |
