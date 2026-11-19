# typeform operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `typeform.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | The account of the token (alias, email, language) |  |
| `list_forms` | Forms the token can access, with ids, titles and links (newest first unless sorted) | search, workspace_id, sort_by, order_by, cursor, limit |
| `get_form` | A form's definition: fields (questions with id and ref), logic, settings, and _links.responses (whose host shows the data center) | **form_id** |
| `create_form` | Create a form from a Create API form definition ({title, fields, settings, ...}) (as an agent tool only when TYPEFORM_TOOL_ALLOW_CREATE=1) | **form** |
| `delete_form` | Delete a form and all its responses permanently | **form_id** |
| `list_responses` | Submitted responses, newest first (answers keyed by field id/ref); next_cursor pages to older ones. Responses of the last ~30 minutes may be missing | **form_id**, since, until, after, included_response_ids, excluded_response_ids, response_type, search, fields, answered_fields, cursor, limit |
| `delete_responses` | Delete responses by id (up to 1000; deletion is queued, unknown ids are ignored) | **form_id**, **included_response_ids** |
| `get_insights_summary` | Form and per-question insights: visits, responses, completion rate, average time (plan-dependent) | **form_id** |
| `list_workspaces` | Workspaces the token can access, with form counts | search, cursor, limit |
| `get_workspace` | One workspace with its members and forms link | **workspace_id** |
| `api_request` | Call any Typeform API endpoint that has no dedicated operation, e.g. path "/forms/<id>/messages". Only the API's own host is allowed. Agent tools may only read /me, /forms, /forms/{id}, /forms/{id}/responses, /forms/{id}/messages, /workspaces, /themes, /images and /insights/{id}/summary. | method, **path**, query, body |
