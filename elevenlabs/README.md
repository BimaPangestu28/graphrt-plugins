# elevenlabs

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [ElevenLabs API](https://elevenlabs.io/docs/api-reference).
It turns text into speech and sound effects, saved as audio files. It also transcribes audio and video, and lists
voices, models, generation history and subscription usage. The plugin is declarative: see
[`definition.mjs`](definition.mjs) and [docs/declarative-plugins.md](../docs/declarative-plugins.md).

## Features
- **`text_to_speech`:** text to speech with a voice and model (`eleven_multilingual_v2` by default, or `eleven_v3`,
  `eleven_flash_v2_5` and others), voice settings, seed, continuity text and output format. Saved to `ELEVENLABS_OUTPUT_DIR`.
- **`generate_sound_effect`:** a sound effect from a description (0.5–30 s, can loop). Saved to `ELEVENLABS_OUTPUT_DIR`.
- **`speech_to_text`:** Scribe transcription of an uploaded file or a `source_url` (exactly one, checked before any
  request). Returns word timestamps, diarization, audio-event tags and key terms.
- **`list_voices`** (search, filters, paginated) and **`get_voice`**.
- **`list_models`:** models, their languages, limits and cost factor.
- **`list_history`** (paginated) and **`get_history_audio`**, which downloads a past generation again at no cost.
- **`get_subscription`:** tier, characters used and character limit, when the limit resets, and voice slots.
- **`clone_voice`** (instant voice clone from one sample) and **`delete_voice`**. Both are node only.
- **`api_request`:** any other endpoint (GET only for agents).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An ElevenLabs account and API key

## Installation
```bash
graphrt plugin install ./elevenlabs
```
No dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | yes | API key, sent as the `xi-api-key` header |
| `ELEVENLABS_OUTPUT_DIR` | for audio output | Absolute directory where `text_to_speech`, `generate_sound_effect` and `get_history_audio` write files (created if missing). Without it those operations are refused before any request. |
| `ELEVENLABS_UPLOAD_DIR` | optional | Absolute directory that local files for `speech_to_text` and `clone_voice` must be inside (realpath checked, regular files only, up to 100 MB). Without it only https URLs work. **Any file in this directory can be sent to ElevenLabs by an agent** through `speech_to_text`. Only point it at a folder that holds nothing else. |

**Getting a key:** go to elevenlabs.io, then Developers, then API Keys, and create a key. You can limit the key to
the endpoints you use (Text to Speech, Speech to Text, Sound Effects, Voices read, Models, History, User read) and
give it a credit quota. A key without a needed permission gets `401`/`403` from the API.

## Pricing
These are paid calls, billed against your plan's credits. Prices are from
[elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api), November 2026.
- **Text to speech:** about $0.08 per 1,000 characters for Multilingual v2 and v3, and about $0.04 per 1,000 for
  Flash/Turbo.
- **Speech to text:** Scribe is about $0.20 per hour of audio.
- **Sound effects:** about $0.12 per minute generated.
- **Plans:** Free (10k characters a month), Starter $6, Creator $22, Pro $99, Scale $299, Business $990.

Use `get_subscription` to see `character_count` and `character_limit`. Reads (voices, models, history, subscription
and history audio downloads) are free.

## Quick Start
```bash
ELEVENLABS_API_KEY=... graphrt run elevenlabs/example.yaml --plugins .
```
The example shows your character usage and five premade voices. It spends no credits.

## Usage
```yaml
- id: speak
  type: elevenlabs.text_to_speech
  voice_id: JBFqnCBsd6RMkjVDRZzb
  text: "{{#start.text#}}"
  model_id: eleven_multilingual_v2
  output_format: mp3_44100_128
  voice_settings: { stability: 0.5, similarity_boost: 0.75 }
- id: transcribe
  type: elevenlabs.speech_to_text
  file: "{{#speak.data.path#}}"        # needs ELEVENLABS_UPLOAD_DIR to contain ELEVENLABS_OUTPUT_DIR
  diarize: true
```
- Audio operations return `data: {path, bytes, content_type}`.
- `speech_to_text` returns ElevenLabs' transcript: `text`, `language_code`, `words[]` with timings and
  `speaker_id`.
- `list_voices` and `list_history` return the items, plus a `next_cursor` you pass back as `cursor`.

## Agent policy
- **Agent tools:** text to speech, sound effects and speech to text are available. They spend credits, so set a key
  quota for agent use.
- **Node only:** `clone_voice` (it needs the speaker's consent) and `delete_voice`.
- **`api_request`:** GET only for agents.
- **No automatic retries for paid calls:** text to speech, sound effects, speech to text and voice cloning are
  never retried after a timeout, network error or 5xx. ElevenLabs may already have done the work and billed it. Text
  to speech and sound effects also create a history item. The error says "outcome unknown" and points to
  `list_history` and `get_subscription` to check before calling again.
- **Upload directory:** an agent can upload any file inside `ELEVENLABS_UPLOAD_DIR` to ElevenLabs with
  `speech_to_text`. Keep only audio meant for transcription there.

## Errors
- Errors are read from `{"detail": {"code", "message"}}`.
- **`auth_error`:** `invalid_api_key` or `missing_api_key`.
- **`rate_limited`:** `rate_limit_exceeded`, `concurrent_limit_exceeded`, `system_busy` and `quota_exceeded`. The
  concurrency and busy errors are retried.
- **Validation errors:** 422 errors report the first `detail[].msg`.
- **Missing output directory:** audio operations without `ELEVENLABS_OUTPUT_DIR` fail with `invalid_input`.

## Not covered
- **Dubbing:** the `/v1/dubbing` endpoints are deprecated in favour of dubbing projects.
- **Also not covered:** music, voice design, speech to speech, the conversational agents platform and WebSocket
  streaming.
- **Voice clones:** `clone_voice` takes one sample file.

## Testing
```bash
npm test          # from the repo root
```

## License
Apache-2.0
