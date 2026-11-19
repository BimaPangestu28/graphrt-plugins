# anthropic operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `anthropic.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_message` | Ask Claude (not streamed); the reply text is in content[] blocks of type text. Check stop_reason (end_turn, max_tokens, refusal, tool_use) | model, max_tokens, **messages**, system, tools, tool_choice, thinking, output_config, stop_sequences, metadata |
| `count_tokens` | Count the input tokens a message request would use (free) | model, **messages**, system, tools, tool_choice, thinking |
| `list_models` | List available Claude models, newest first, with max_input_tokens, max_tokens and capabilities | cursor, limit |
| `get_model` | Get one model's context window, output cap and capabilities | **model_id** |
| `create_message_batch` | Queue up to 100,000 Messages requests at 50% of the price; results within 24 h (poll get_message_batch) (as an agent tool only when ANTHROPIC_TOOL_ALLOW_BATCH=1) | **requests** |
| `get_message_batch` | Get a batch's processing_status (in_progress, canceling, ended) and request_counts | **batch_id** |
| `list_message_batches` | List message batches, newest first | cursor, limit |
| `cancel_message_batch` | Cancel a batch that is still processing (finished requests are still billed) | **batch_id** |
| `delete_message_batch` | Delete an ended batch and its results | **batch_id** |
| `upload_file` | Upload a file (PDF, text, image) to reference in messages as {"type":"document","source":{"type":"file","file_id":...}} | **file** |
| `list_files` | List uploaded files, newest first | cursor, limit |
| `get_file` | Get an uploaded file's metadata | **file_id** |
| `delete_file` | Delete an uploaded file | **file_id** |
| `api_request` | Call any Claude API endpoint that has no dedicated operation, e.g. path "/v1/models". Only the API's own host is allowed. | method, **path**, query, body |
| `get_message_batch_results` | Results of an ended message batch as a list of {custom_id, result: {type: succeeded\|errored\|canceled\|expired, message\|error}} in any order; filter with custom_ids or result_type and page with offset (agents see 100 at a time) | **batch_id**, result_type, custom_ids, offset |
