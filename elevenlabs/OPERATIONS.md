# elevenlabs operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `elevenlabs.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `text_to_speech` | Convert text to speech with a voice and save the audio file in ELEVENLABS_OUTPUT_DIR (billed per character) | **voice_id**, **text**, model_id, language_code, voice_settings, seed, previous_text, next_text, apply_text_normalization, output_format, enable_logging |
| `generate_sound_effect` | Generate a sound effect from a text description and save the audio file in ELEVENLABS_OUTPUT_DIR (billed per generation) | **text**, duration_seconds, prompt_influence, loop, model_id, output_format |
| `speech_to_text` | Transcribe an audio or video file (exactly one of file: an https URL or a file inside ELEVENLABS_UPLOAD_DIR, or source_url) with word timestamps, speaker diarization and audio-event tags (billed per hour of audio) | model_id, file, source_url, language_code, tag_audio_events, num_speakers, timestamps_granularity, diarize, keyterms, temperature, enable_logging |
| `list_voices` | Search and list the voices available to the account (premade, cloned, generated, library), with ids, labels and preview URLs | search, voice_type, category, sort, sort_direction, include_total_count, cursor, limit |
| `get_voice` | Get one voice: name, category, labels, description, preview URL, samples and settings | **voice_id** |
| `list_models` | List the models (TTS, speech to speech) with their languages, capabilities, character limits and cost factor |  |
| `list_history` | List generated speech items (newest first) with text, voice, model and character counts | voice_id, model_id, search, source, date_after_unix, date_before_unix, sort_direction, cursor, limit |
| `get_history_audio` | Download the audio of a history item into ELEVENLABS_OUTPUT_DIR (free: no new generation) | **history_item_id** |
| `get_subscription` | Subscription tier, characters used and limit, reset time, voice slots and cloning access |  |
| `clone_voice` | Create an instant voice clone from an audio sample (https URL or a file inside ELEVENLABS_UPLOAD_DIR); you must have the speaker's consent | **name**, **sample**, description, labels, remove_background_noise |
| `delete_voice` | Delete a voice permanently | **voice_id** |
| `api_request` | Call any ElevenLabs API endpoint that has no dedicated operation, e.g. path "/v1/user/subscription". Only the API's own host is allowed. | method, **path**, query, body |
