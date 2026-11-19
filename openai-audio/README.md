# openai-audio

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio). It turns text into speech saved as audio
files, transcribes audio in its own language, and translates audio into English text. The plugin is declarative:
see [`definition.mjs`](definition.mjs) and [docs/declarative-plugins.md](../docs/declarative-plugins.md).

## Features
- **`create_speech`:** text (up to 4096 characters) to speech.
  - Models: `gpt-4o-mini-tts` (the default, which also takes `instructions` for tone and accent), `tts-1` and
    `tts-1-hd`.
  - 13 built-in voices, six formats (mp3, opus, aac, flac, wav, pcm) and speed 0.25–4.
  - The audio is saved to `OPENAI_AUDIO_OUTPUT_DIR`.
- **`create_transcription`:** audio up to 25 MB to text.
  - Models: `gpt-4o-mini-transcribe` (the default), `gpt-4o-transcribe`, `gpt-4o-transcribe-diarize`,
    `gpt-transcribe` and `whisper-1`.
  - Options: language, prompt, response format (json, text, srt, vtt, verbose_json, diarized_json), word or
    segment timestamps, logprobs and chunking.
- **`create_translation`:** audio in any supported language to English text (`whisper-1`).
- **`list_models`:** the models your key can use.
- **`api_request`:** any other endpoint (GET only for agents).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An OpenAI API key with billing enabled

## Installation
```bash
graphrt plugin install ./openai-audio
```
No dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | API key, sent as `Authorization: Bearer` |
| `OPENAI_AUDIO_OUTPUT_DIR` | for `create_speech` | Absolute directory for the generated audio files (created if missing). Without it `create_speech` is refused before any request. |
| `OPENAI_AUDIO_UPLOAD_DIR` | optional | Absolute directory that local input files must be inside. The path is resolved with realpath, so symlinks cannot point outside it, and only regular files up to 25 MB are read. Without it only https URLs work. URL inputs are downloaded from public hosts only. |

**Getting a key:** create one at platform.openai.com, under API keys. A restricted key needs the **Model
capabilities → Audio** permission (write) for these endpoints, and **Models** (read) for `list_models`. The key's
project must have billing set up.

## Pricing
These are paid calls, charged to the key's project. Prices are from
[OpenAI pricing](https://platform.openai.com/docs/pricing), November 2026:
- **tts-1:** $15 per 1M characters.
- **tts-1-hd:** $30 per 1M characters.
- **gpt-4o-mini-tts:** $0.60 per 1M text input tokens and $12 per 1M audio output tokens.
- **whisper-1:** $0.006 per minute of audio.
- **gpt-4o-transcribe:** about $0.006 per minute.
- **gpt-4o-mini-transcribe:** about $0.003 per minute.
- **gpt-transcribe:** about $0.0045 per minute.

Set a project budget if agents use these tools.

**Deprecation:** OpenAI has announced shutdown dates for the current audio models.
- The `/audio/speech` models shut down on 2027-01-06. Their successor is the Realtime API.
- whisper-1, the gpt-4o transcribe models and `/audio/translations` shut down on 2027-02-26. Use `gpt-transcribe`
  for new transcription work.

## Quick Start
```bash
OPENAI_API_KEY=... graphrt run openai-audio/example.yaml --plugins .
```
The example lists your models. It is free.

## Usage
```yaml
- id: speak
  type: openai-audio.create_speech
  input: "{{#start.text#}}"
  voice: coral
  instructions: "Cheerful, Indonesian accent"
- id: transcript
  type: openai-audio.create_transcription
  file: https://example.com/meeting.mp3
  model: gpt-4o-transcribe
  language: id
```
- **`create_speech`:** returns `data: {path, bytes, content_type}`.
- **`create_transcription` and `create_translation`:** return OpenAI's JSON, at least `{text}`. `verbose_json` adds
  `segments` and `words`, and `diarized_json` adds speaker segments. The text formats (`text`, `srt`, `vtt`) come
  back as `{text: "<raw body>"}`.
- **Model and format limits:** not every model supports every format. For example, `gpt-4o(-mini)-transcribe` only
  supports `json`, and timestamps need `whisper-1` with `verbose_json`. OpenAI reports an unsupported combination
  as `invalid_input`.

## Agent policy
- **Agent tools:** all operations, which are paid generation and transcription plus a free model list.
  `api_request` is GET only for agents.
- **No automatic retries for paid calls:** speech, transcription and translation are never retried after a
  timeout, network error or 5xx, because OpenAI may already have processed and billed them. The error says "outcome
  unknown" and points to the project's usage page.
- **Time budget:** a call has 290 s in all. Requests may take up to 170 s, so an https audio input has about 120 s
  to download. A request that would not get its full time is not started.

## Errors
- Errors are read from `{"error": {"message", "code"}}`.
- **`auth_error`:** `invalid_api_key` (and any 401).
- **`rate_limited`:** `insufficient_quota` and `rate_limit_exceeded`.
- **`not_found`:** `model_not_found`.
- **Missing output directory:** `create_speech` without `OPENAI_AUDIO_OUTPUT_DIR` fails with `invalid_input`.
- **Upload directory:** a local file outside `OPENAI_AUDIO_UPLOAD_DIR` fails with `invalid_input`.

## Not covered
- **Streaming:** SSE output for speech and transcription.
- **Voices:** custom voice creation and voice consents.
- **Other APIs:** the Realtime API.
- **Organization and project headers:** `OpenAI-Organization` and `OpenAI-Project` are not sent. A key belongs to
  one project, so they are rarely needed.
- **Chunking:** `chunking_strategy` only takes `auto`. Server-VAD tuning is not exposed.

## Testing
```bash
npm test          # from the repo root
```

## License
Apache-2.0
