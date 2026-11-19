# google-docs operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-docs.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_document` | A document's structure and text (body.content, or tabs[] with include_tabs_content) | **document_id**, include_tabs_content, suggestions_view_mode |
| `create_document` | Create an empty document with a title (in the root of the caller's Drive) | **title** |
| `insert_text` | Insert text at an index, or append it at the end of the body | **document_id**, **text**, index, tab_id, required_revision_id |
| `replace_all_text` | Replace every occurrence of a text, e.g. template placeholders like {{name}} | **document_id**, **find**, replace_with, delete_matches, match_case, tab_ids, required_revision_id |
| `batch_update` | Apply raw batchUpdate requests (formatting, tables, images, deletions, ...) (as an agent tool only when GOOGLE_DOCS_TOOL_ALLOW_BATCH_UPDATE=1) | **document_id**, **requests**, required_revision_id |
| `api_request` | Call any Google Docs API endpoint that has no dedicated operation, e.g. path "/documents/<id>". Only the API's own host is allowed. | method, **path**, query, body |
