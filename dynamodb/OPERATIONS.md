# dynamodb operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `dynamodb.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_tables` | List DynamoDB table names in the region, paginated with next_cursor | limit, cursor |
| `describe_table` | Describe a table: key schema, attribute types, item count, size, billing mode and indexes | **table** |
| `get_item` | Read one item by its primary key; data.item is null when it does not exist | **table**, **key**, consistent_read, projection_expression, expression_attribute_names, attribute_format |
| `query` | Query items by partition key (and optional sort key condition) on a table or index, one page with next_cursor | **table**, **key_condition_expression**, expression_attribute_values, filter_expression, index_name, scan_index_forward, consistent_read, projection_expression, expression_attribute_names, attribute_format, limit, cursor |
| `scan` | Scan a table or index page by page (reads every item: prefer query), with optional filter and next_cursor | **table**, filter_expression, expression_attribute_values, index_name, consistent_read, projection_expression, expression_attribute_names, attribute_format, limit, cursor |
| `batch_get_items` | Read up to 100 items of one table by primary key; unprocessed keys are retried, any left over are returned | **table**, **keys**, consistent_read, projection_expression, expression_attribute_names, attribute_format |
| `put_item` | Create or replace an item, optionally only when a condition holds (as an agent tool only when DYNAMODB_TOOL_ALLOW_WRITES=1) | **table**, **item**, condition_expression, expression_attribute_names, expression_attribute_values, return_old_item, attribute_format |
| `update_item` | Update attributes of one item with an update expression (creates the item if missing unless a condition prevents it; as an agent tool only when DYNAMODB_TOOL_ALLOW_WRITES=1) | **table**, **key**, **update_expression**, condition_expression, expression_attribute_names, expression_attribute_values, return_values, attribute_format |
| `delete_item` | Delete one item by primary key, optionally only when a condition holds; workflow nodes only | **table**, **key**, condition_expression, expression_attribute_names, expression_attribute_values, return_old_item, attribute_format |
