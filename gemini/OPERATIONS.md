# gemini operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `gemini.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate_content` | Ask Gemini (not streamed); the text is in candidates[0].content.parts[].text. Check candidates[0].finishReason and promptFeedback.blockReason (urlContext from agents only when GEMINI_TOOL_ALLOW_URL_CONTEXT=1) | **model**, **contents**, system_instruction, generation_config, tools, tool_config, safety_settings, cached_content |
| `count_tokens` | Count the tokens of contents for a model (free) | **model**, **contents** |
| `embed_content` | Embed one text; the vector is in embedding.values | **model**, **content**, task_type, document_title, output_dimensionality |
| `batch_embed_contents` | Embed up to 100 texts in one call; embeddings[i].values belongs to requests[i] | **model**, **requests** |
| `list_models` | List Gemini models with their token limits and supportedGenerationMethods | cursor, limit |
| `get_model` | Get one model's token limits, defaults and supported methods | **model** |
| `list_files` | List files uploaded with upload_file (kept 48 hours) | cursor, limit |
| `get_file` | Get a file's metadata and state (PROCESSING, ACTIVE, FAILED); use it in prompts once ACTIVE | **file_id** |
| `delete_file` | Delete an uploaded file | **file_id** |
| `api_request` | Call any Gemini API endpoint that has no dedicated operation, e.g. path "/models". Only the API's own host is allowed. | method, **path**, query, body |
| `upload_file` | Upload a file (PDF, image, audio, video, text; max 100 MB here) for use in prompts as {"fileData":{"fileUri": file.uri, "mimeType": ...}}; files are kept 48 hours | **file**, display_name, mime_type |
