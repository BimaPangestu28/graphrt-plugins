# notion-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `notion-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search` | Search the pages and data sources shared with the integration by title, newest edits first by default. | query, object_type, sort_direction, limit, cursor |
| `get_page` | Get a Notion page's properties, parent, URL and trash status (not its content; use get_block_children for that). | **page_id** |
| `get_page_property` | Get one property of a page in full, paginated for long titles/rich text, relations and people (get_page truncates them at 25 items). | **page_id**, property_id, property_name, limit, cursor |
| `create_page` | Create a page in a database (data source) or under a page, with properties as a simple {name: value} map and/or Notion JSON, and optional plain-text paragraphs. Never retried after an unknown outcome. | data_source_id, database_id, parent_page_id, values, properties, paragraphs, icon_emoji |
| `update_page_properties` | Update some properties of a page; others are left unchanged. Takes a simple {name: value} map and/or Notion JSON. | **page_id**, values, properties |
| `archive_page` | Move a page to the Notion trash (in_trash). Reversible with restore_page. | **page_id** |
| `restore_page` | Restore a page from the Notion trash. | **page_id** |
| `get_database` | Get a Notion database: title, parent and its `data_sources` (id and name of each table). | **database_id** |
| `get_data_source` | Get a Notion data source (a database table) with its property schema: names, types and select options. | data_source_id, database_id |
| `query_database` | Query the pages of a Notion database (its data source) with an optional Notion filter and sorts, one page of results at a time. | data_source_id, database_id, filter, sorts, limit, cursor |
| `get_block_children` | Read the content of a page or block: its child blocks (paragraphs, headings, lists, ...), one page at a time. | **block_id**, limit, cursor |
| `append_paragraphs` | Append plain-text paragraphs (at most 100 per call, 400000 characters in total) to a page or block, at the end by default. Never retried after an unknown outcome. | **block_id**, **paragraphs**, after_block_id, at_start |
| `add_comment` | Add a plain-text comment to a page, a block or an existing discussion thread. Never retried after an unknown outcome. | page_id, block_id, discussion_id, **text** |
| `api_request` | Call any Notion API endpoint that has no dedicated operation, e.g. path "/users/me". Only the API's own host is allowed. | method, **path**, query, body |
