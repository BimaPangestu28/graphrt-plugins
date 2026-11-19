# deepgram operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `deepgram.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `transcribe_url` | Transcribe pre-recorded audio or video that Deepgram fetches from a public URL (billed per minute of audio) | **url**, model, language, detect_language, smart_format, punctuate, diarize, paragraphs, utterances, summarize, topics, intents, sentiment, detect_entities, keyterm, redact, numerals, profanity_filter, filler_words, multichannel, tag |
| `transcribe_file` | Transcribe a pre-recorded audio or video file (an https URL that this plugin downloads, or a file inside DEEPGRAM_UPLOAD_DIR; billed per minute of audio) | **file**, model, language, detect_language, smart_format, punctuate, diarize, paragraphs, utterances, summarize, topics, intents, sentiment, detect_entities, keyterm, redact, numerals, profanity_filter, filler_words, multichannel, tag |
| `text_to_speech` | Turn text (up to 2000 characters) into speech with an Aura voice and save the audio file in DEEPGRAM_OUTPUT_DIR (billed per character) | **text**, model, encoding, container, sample_rate, bit_rate |
| `analyze_text` | Summarize text and detect topics, intents and sentiment (exactly one of text or url; billed per token) | text, url, language, summarize, topics, intents, sentiment |
| `list_models` | List the speech-to-text (stt) and text-to-speech (tts) models with languages and versions | include_outdated |
| `get_model` | Get one model by its uuid | **model_id** |
| `list_projects` | List the projects the key can access (project_id and name) |  |
| `get_project_balances` | Remaining credit balances of a project | **project_id** |
| `list_project_requests` | List a project's API requests (newest first) with endpoint, status and response summary | **project_id**, start, end, endpoint, method, status, request_id, cursor, limit |
| `api_request` | Call any Deepgram API endpoint that has no dedicated operation, e.g. path "/v1/projects". Only the API's own host is allowed. | method, **path**, query, body |
