# deepgram

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Deepgram API](https://developers.deepgram.com/reference).
It transcribes pre-recorded audio by URL or from a file, turns text into speech with Aura voices saved as audio
files, analyzes text (summary, topics, intents, sentiment), and reads models, projects, balances and request
history.

The plugin is declarative ([`definition.mjs`](definition.mjs), see
[docs/declarative-plugins.md](../docs/declarative-plugins.md)). `transcribe_file` sends the audio as the raw
request body (the layer's `bodyMode: "file"`). One time budget covers downloading an https input and uploading it.
[`lib/require-one-of.mjs`](lib/require-one-of.mjs) adds the one check the spec cannot express: `analyze_text`
needs exactly one of `text` or `url`.

## Features
- **`transcribe_url`:** Deepgram fetches the media from a public URL.
- **`transcribe_file`:** uploads an https URL or a local file from `DEEPGRAM_UPLOAD_DIR` (up to 200 MB).
- **Transcription options:** both transcribe operations default to `nova-3` with `smart_format`. Options include
  language and detection, diarization, paragraphs, utterances, summary (v2), topics, intents, sentiment, entities,
  key terms, redaction (pci/pii/numbers), numerals, profanity filter, filler words, multichannel and tags.
- **`text_to_speech`:** Aura-2 voices, `aura-2-thalia-en` by default. Takes encoding, container, sample rate and
  bit rate. The audio is saved to `DEEPGRAM_OUTPUT_DIR`.
- **`analyze_text`:** summary, topics, intents and sentiment for `text` or a text `url` (exactly one, checked
  before any request).
- **Models:** `list_models` (stt and tts) and `get_model`.
- **Projects:** `list_projects`, `get_project_balances` and `list_project_requests` (paginated; filter by endpoint,
  method, status and dates).
- **`api_request`:** any other endpoint, GET only for agents.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Deepgram account and API key

## Installation
```bash
graphrt plugin install ./deepgram
```
No dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>` |
| `DEEPGRAM_OUTPUT_DIR` | for `text_to_speech` | Absolute directory for generated audio (created if missing). Without it `text_to_speech` is refused before any request. |
| `DEEPGRAM_UPLOAD_DIR` | optional | Absolute directory that local files for `transcribe_file` must be inside. Paths are resolved with realpath, so symlinks cannot leave it, and only regular files up to 200 MB are read. Without it, only https URLs work, downloaded from public hosts only. |

**Getting a key:** sign up at console.deepgram.com, open a project, go to **API Keys** and create a key. A
default (Member) key covers transcription, TTS, text intelligence and models. Balances and request history can
need a key with broader usage and billing scopes. Without them, Deepgram answers `INSUFFICIENT_PERMISSIONS`, which
becomes `permission_denied`.

## Pricing
Transcription, TTS and text intelligence are billed to the project. Pay-as-you-go prices from
[deepgram.com/pricing](https://deepgram.com/pricing), November 2026:
- **Nova-3 pre-recorded:** about $0.0043 per minute, or $0.0052 per minute for multilingual. Some add-ons, such as
  redaction and diarization, cost extra.
- **Aura-2 TTS:** $0.030 per 1,000 characters.
- **Text intelligence:** $0.0003 per 1,000 input tokens and $0.0006 per 1,000 output tokens.
- **Free credit:** new accounts get $200 that does not expire.

Use `get_project_balances` to watch the credit. Model, project and request reads are free.

## Quick Start
```bash
DEEPGRAM_API_KEY=... graphrt run deepgram/example.yaml --plugins .
```
The example lists your projects and models. It is free.

## Usage
```yaml
- id: transcript
  type: deepgram.transcribe_url
  url: https://dpgr.am/spacewalk.wav
  diarize: true
  summarize: v2
- id: voice
  type: deepgram.text_to_speech
  text: "{{#transcript.data.results.summary.short#}}"
  model: aura-2-thalia-en
```
- **Transcribe operations:** return Deepgram's response. The text is at
  `results.channels.0.alternatives.0.transcript`, alongside `words`, `paragraphs`, `utterances`, `summary`,
  `topics` and `intents`, depending on the options.
- **`text_to_speech`:** returns `data: {path, bytes, content_type}`.
- **`list_project_requests`:** returns `requests`. Pass `next_cursor` back as `cursor` for the next page. Pages are
  numbered from 0.

## Agent policy
- **Agent tools:** every operation is available, including the paid transcription, TTS and text intelligence.
  There are no deletes or account changes. `api_request` is GET only for agents.
- **No automatic retries for paid calls:** transcription, TTS and analysis are never retried after a timeout,
  network error or 5xx, because Deepgram may already have processed and billed them. Their errors say "outcome
  unknown" and point to `list_project_requests` to check before calling again.
- **Callbacks:** the `callback` option is not exposed. Results never go to a third-party URL.

## Errors
- **Error body:** errors are read from `{"err_code", "err_msg"}`, or from `{"message"}` in newer error bodies.
- **Mapped kinds:**
  - `INVALID_AUTH` becomes `auth_error`.
  - `INSUFFICIENT_PERMISSIONS` becomes `permission_denied`.
  - `TOO_MANY_REQUESTS` becomes `rate_limited`.
  - `PAYLOAD_TOO_LARGE` and `INVALID_QUERY_PARAMETER` become `invalid_input`.
  - `PROJECT_NOT_FOUND` becomes `not_found`.
- **TTS text limit:** text over 2000 characters is a 413 from Deepgram.

## Not covered
Streaming (WebSocket) transcription and TTS, the Voice Agent API, callbacks, key and member management, and usage
breakdowns (reachable with `api_request`).

## Testing
```bash
npm test          # from the repo root
```
- **`test/contract.test.mjs`:** the generated contract suite, including the file-input checks (allowlist,
  symlinks, FIFOs, size cap, non-https URLs, redaction).
- **`test/transcribe-file.test.mjs`:** the raw upload's bytes, content type and query, auth errors and truncation.
- **`test/paid-calls.test.mjs`:** https inputs and the size cap, no retry after 5xx or network failure, key
  redaction, and the `analyze_text` one-of check.

## License
Apache-2.0
