# hubspot operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `hubspot.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_objects` | A page of records of one object type (oldest first); use search_objects to filter or sort | **object_type**, properties, associations, archived, cursor, limit |
| `get_object` | One record by id, or by a unique property such as email (id_property) | **object_type**, **object_id**, properties, properties_with_history, associations, id_property, archived |
| `search_objects` | Search records with filters (AND within a group, OR across up to 5 groups), a text query and one sort; at most 10,000 results per search | **object_type**, query, filter_groups, sorts, properties, cursor, limit |
| `create_object` | Create a record with property values, optionally associated with other records | **object_type**, **properties**, associations |
| `update_object` | Change property values of a record (empty string clears a value) | **object_type**, **object_id**, id_property, **properties** |
| `archive_object` | Move a record to the recycle bin (restorable for 90 days) | **object_type**, **object_id** |
| `list_associations` | Records of one object type associated with a record, with association labels | **from_object_type**, **from_object_id**, **to_object_type**, cursor, limit |
| `associate_objects` | Create the default (unlabeled) association between two records, e.g. a contact and a company | **from_object_type**, **from_object_id**, **to_object_type**, **to_object_id** |
| `remove_association` | Remove every association between two records (the records stay) | **from_object_type**, **from_object_id**, **to_object_type**, **to_object_id** |
| `create_note` | Add a note to the timeline of contacts, companies, deals or tickets | **body**, timestamp, owner_id, contact_ids, company_ids, deal_ids, ticket_ids |
| `list_properties` | Property definitions of an object type: internal names, labels, types and dropdown options | **object_type**, archived |
| `list_pipelines` | Deal or ticket pipelines with their stages (stage ids for dealstage / hs_pipeline_stage) | **object_type** |
| `list_owners` | Users that records can be assigned to (ids for hubspot_owner_id) | email, archived, cursor, limit |
| `get_account_details` | Portal id, time zone, currency and data hosting location of the account |  |
| `api_request` | Call any HubSpot API endpoint that has no dedicated operation, e.g. path "/crm/objects/2026-09/contacts/<id>/associations/deals". Only the API's own host is allowed. Agent tools may only read paths under /crm/objects, /crm/properties, /crm/pipelines, /crm/owners, /crm/associations, /crm/v3/objects, /crm/v3/properties, /crm/v3/pipelines, /crm/v3/owners, /crm/v4/objects, /crm/v4/associations, /account-info/2026-09/details, /account-info/v3/details. | method, **path**, query, body |
