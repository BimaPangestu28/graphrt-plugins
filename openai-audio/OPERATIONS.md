# openai-audio operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `openai-audio.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `create_speech` | Turn text (up to 4096 characters) into speech and save the audio file in OPENAI_AUDIO_OUTPUT_DIR (billed per character or token) | **input**, model, voice, instructions, response_format, speed |
| `create_transcription` | Transcribe audio to text in its own language (https URL or a file inside OPENAI_AUDIO_UPLOAD_DIR; billed per minute of audio) | **file**, model, language, prompt, response_format, temperature, timestamp_granularities, include, chunking_strategy |
| `create_translation` | Transcribe audio in any supported language into English text (https URL or a file inside OPENAI_AUDIO_UPLOAD_DIR; whisper-1, billed per minute) | **file**, model, prompt, response_format, temperature |
| `list_models` | List the models the key can use (look for tts-*, *-transcribe and whisper-1) |  |
| `api_request` | Call any OpenAI API endpoint that has no dedicated operation, e.g. path "/models". Only the API's own host is allowed. | method, **path**, query, body |
