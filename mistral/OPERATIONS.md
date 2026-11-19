# mistral operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `mistral.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_chat_completion` | Generate a chat completion (not streamed); the answer is in choices[0].message.content | **model**, **messages**, max_tokens, temperature, response_format, tools, safe_prompt, random_seed, stop |
| `create_fim_completion` | Complete code between a prompt and an optional suffix with Codestral; the code is in choices[0].message.content | model, **prompt**, suffix, max_tokens, stop |
| `create_embeddings` | Embed texts as vectors; data[i].embedding belongs to input[i] | model, **input**, output_dimension, output_dtype |
| `moderate_text` | Classify texts against Mistral's moderation categories; results[i].categories and category_scores | model, **input** |
| `moderate_chat` | Classify the last message of a conversation in its context | model, **input** |
| `ocr_document` | Read a PDF or image into markdown per page (pages[].markdown), with optional structured annotation | model, **document**, pages, include_image_base64, image_limit, table_format, extract_header, extract_footer, document_annotation_format, document_annotation_prompt |
| `list_models` | List models available to the API key |  |
| `get_model` | Get one model's capabilities, context length and aliases | **model_id** |
| `list_files` | List uploaded files | purpose, search, cursor, limit |
| `upload_file` | Upload a file (batch .jsonl, a document for OCR, fine-tuning data) and get its id | **file**, **purpose** |
| `get_file` | Get an uploaded file's metadata | **file_id** |
| `download_file_content` | Save a file's content (e.g. a batch job's output_file) into $MISTRAL_OUTPUT_DIR | **file_id** |
| `delete_file` | Delete an uploaded file | **file_id** |
| `create_batch_job` | Start a batch job over uploaded .jsonl files or inline requests (half price); poll it with get_batch_job (as an agent tool only when MISTRAL_TOOL_ALLOW_BATCH=1) | **endpoint**, model, input_files, requests, metadata, timeout_hours |
| `get_batch_job` | Get a batch job's status, counts and output_file | **job_id** |
| `list_batch_jobs` | List batch jobs, newest first | status, cursor, limit |
| `cancel_batch_job` | Request cancellation of a batch job (finished requests are still billed) | **job_id** |
| `api_request` | Call any Mistral AI API endpoint that has no dedicated operation, e.g. path "/v1/models". Only the API's own host is allowed. | method, **path**, query, body |
