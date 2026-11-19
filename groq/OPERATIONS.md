# groq operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `groq.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_chat_completion` | Generate a chat completion on Groq (not streamed); the answer is in choices[0].message.content | **model**, **messages**, max_completion_tokens, temperature, response_format, tools, reasoning_effort, reasoning_format, seed, stop |
| `list_models` | List the models available on Groq, with context_window |  |
| `get_model` | Get one model's owner, context window and status | **model** |
| `transcribe_audio` | Speech to text in the spoken language with Whisper; the text is in text | model, file, url, prompt, response_format, temperature, language |
| `translate_audio` | Speech in any language to English text with Whisper | model, file, url, prompt, response_format, temperature |
| `create_speech` | Turn text into speech and save the audio into $GROQ_OUTPUT_DIR | **model**, **input**, **voice**, response_format, sample_rate, speed |
| `list_files` | List uploaded files |  |
| `upload_file` | Upload a .jsonl batch input file and get its file id | **file**, purpose |
| `get_file` | Get an uploaded file's metadata | **file_id** |
| `download_file_content` | Save a file's content (e.g. a batch's output_file_id) into $GROQ_OUTPUT_DIR | **file_id** |
| `delete_file` | Delete an uploaded file | **file_id** |
| `create_batch` | Start a batch job over an uploaded .jsonl file (cheaper, finishes within the completion window); poll it with get_batch (as an agent tool only when GROQ_TOOL_ALLOW_BATCH=1) | **input_file_id**, endpoint, completion_window, metadata |
| `get_batch` | Get a batch's status and output_file_id | **batch_id** |
| `list_batches` | List batches |  |
| `cancel_batch` | Cancel a running batch (finished requests are still billed) | **batch_id** |
| `api_request` | Call any Groq API endpoint that has no dedicated operation, e.g. path "/models". Only the API's own host is allowed. | method, **path**, query, body |
