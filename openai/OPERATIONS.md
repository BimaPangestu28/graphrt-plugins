# openai operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `openai.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_response` | Generate a model response with the Responses API (text in, text or JSON out; not streamed). The answer text is in output[].content[].text (mcp and connector tools from agents only when OPENAI_TOOL_ALLOW_REMOTE_TOOLS=1) | **model**, **input**, instructions, max_output_tokens, reasoning_effort, text_format, tools, previous_response_id, store, temperature, metadata |
| `get_response` | Get a stored response by id | **response_id** |
| `delete_response` | Delete a stored response | **response_id** |
| `create_chat_completion` | Generate a chat completion (not streamed). The answer is in choices[0].message.content | **model**, **messages**, max_completion_tokens, temperature, response_format, tools, reasoning_effort, seed, stop |
| `create_embeddings` | Embed texts as vectors; data[i].embedding belongs to input[i] | **model**, **input**, dimensions |
| `create_moderation` | Classify text for harmful content (free): results[0].flagged and per-category scores | **input**, model |
| `list_models` | List the models the API key can use |  |
| `get_model` | Get one model's id, owner and creation time | **model** |
| `list_files` | List uploaded files, newest first | purpose, order, cursor, limit |
| `upload_file` | Upload a file (e.g. a .jsonl batch input) and get its file id | **file**, **purpose** |
| `get_file` | Get an uploaded file's metadata | **file_id** |
| `download_file_content` | Save a file's content (e.g. a batch's output_file_id) into $OPENAI_OUTPUT_DIR | **file_id** |
| `delete_file` | Delete an uploaded file | **file_id** |
| `create_batch` | Start a Batch API job over an uploaded .jsonl file (50% cheaper, finishes within 24 h); poll it with get_batch (as an agent tool only when OPENAI_TOOL_ALLOW_BATCH=1) | **input_file_id**, **endpoint**, completion_window, metadata |
| `get_batch` | Get a batch's status (validating, in_progress, completed, failed, expired, cancelled) and output_file_id | **batch_id** |
| `list_batches` | List batches, newest first | cursor, limit |
| `cancel_batch` | Cancel a running batch (finished requests are still billed) | **batch_id** |
| `api_request` | Call any OpenAI API endpoint that has no dedicated operation, e.g. path "/models". Only the API's own host is allowed. | method, **path**, query, body |
