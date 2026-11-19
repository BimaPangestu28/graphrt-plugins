# assemblyai operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `assemblyai.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `upload_file` | Upload a local audio/video file (inside ASSEMBLYAI_UPLOAD_DIR) or an https URL to AssemblyAI; returns an upload_url for transcribe | **file** |
| `transcribe` | Start a transcription and wait for it (wait: false returns the id at once; billed per hour of audio plus enabled features) | **audio_url**, speech_models, language_code, language_detection, punctuate, format_text, speaker_labels, speakers_expected, multichannel, keyterms_prompt, prompt, sentiment_analysis, entity_detection, iab_categories, auto_highlights, content_safety, redact_pii, redact_pii_policies, redact_pii_sub, audio_start_from, audio_end_at, wait |
| `get_transcript` | Get a transcript: status (queued, processing, completed, error), text, words, utterances and feature results | **transcript_id** |
| `list_transcripts` | List transcripts of the last 30 days, newest first (id, status, audio_url, created) | status, created_on, cursor, limit |
| `get_sentences` | A completed transcript split into sentences with timings, confidence and speaker | **transcript_id** |
| `get_paragraphs` | A completed transcript split into paragraphs with timings and confidence | **transcript_id** |
| `get_subtitles` | Export a completed transcript as SRT or WebVTT subtitles (returned as {text}) | **transcript_id**, **subtitle_format**, chars_per_caption |
| `search_words` | Find words or phrases in a completed transcript, with counts and timestamps | **transcript_id**, **words** |
| `delete_transcript` | Permanently delete a transcript's text and data (the record stays, redacted) | **transcript_id** |
| `create_chat_completion` | Ask an LLM through AssemblyAI's LLM Gateway (successor of LeMUR), e.g. to summarize a transcript's text (billed per token) | **model**, messages, prompt, max_tokens, temperature |
| `list_llm_models` | List the models available through the LLM Gateway |  |
| `api_request` | Call any AssemblyAI API endpoint that has no dedicated operation, e.g. path "/v2/transcript". Only the API's own host is allowed. | method, **path**, query, body |
