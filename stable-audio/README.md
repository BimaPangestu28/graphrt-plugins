# stable-audio

**Status:** beta · **ToS risk:** none. Official API; checked live only with a fake key; Stable Audio 3 audio-to-audio and inpainting are not implemented. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for Stability AI's
[Stable Audio API](https://platform.stability.ai/docs/api-reference). It generates music and sound effects from
text, transforms existing audio and regenerates a time range of a track. Audio is saved to files. It also shows
the account's credit balance. The plugin is declarative: see [`definition.mjs`](definition.mjs) and
[docs/declarative-plugins.md](../docs/declarative-plugins.md).

## Features
- **`text_to_audio`:** music or sound from a prompt with Stable Audio 2.5 (the default) or 2, up to 190 s, mp3 or
  wav.
  - Options: seed, steps and cfg scale.
  - Synchronous; the audio bytes are saved to `STABLE_AUDIO_OUTPUT_DIR`.
- **`audio_to_audio`:** transforms input audio with a prompt and a `strength`.
- **`inpaint_audio`:** regenerates `mask_start`–`mask_end` seconds of input audio (Stable Audio 2.5).
- **`text_to_audio_v3`:** Stable Audio 3.0, up to 380 s.
  - Asynchronous: the plugin polls the generation and saves the audio.
  - `wait: false` returns the generation id at once.
- **`get_audio_result`:** fetches a Stable Audio 3 generation by id (kept 24 h). It saves the audio once the
  generation is finished.
- **`get_balance`** (credits) and **`get_account`**.
- **`api_request`:** any other endpoint, GET only for agents.

`audio_to_audio` and `inpaint_audio` take an mp3 or wav input of 6–190 s and up to 50 MB.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Stability AI account with credits

## Installation
```bash
graphrt plugin install ./stable-audio
```
No dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `STABILITY_API_KEY` | yes | API key (`sk-...`), sent as `Authorization: Bearer` |
| `STABLE_AUDIO_OUTPUT_DIR` | for generation | Absolute directory where audio files are written (created if missing). Without it the generation operations are refused before any request, so nothing is paid for. |
| `STABLE_AUDIO_UPLOAD_DIR` | optional | Absolute directory that local input audio must be inside (see below). |

`STABLE_AUDIO_UPLOAD_DIR` rules:
- Paths are resolved with realpath, so symlinks cannot leave the directory.
- Only regular files up to 50 MB are read.
- Without it, only https URLs work, downloaded from public hosts only.

**Getting a key:** sign in at platform.stability.ai, open **Account → API Keys**, and buy credits under
**Billing**.

## Pricing
Generations are paid in credits; 1 credit = $0.01. Failed generations are not charged. Figures are from
Stability's API reference, November 2026:

| Model | Endpoints | Credits per generation |
|---|---|---|
| Stable Audio 2.5 | text-to-audio, audio-to-audio, inpaint | 8 (flat) |
| Stable Audio 2 | text-to-audio, audio-to-audio | 17 + 0.06 × steps (about 20 at 50 steps) |
| Stable Audio 3.0 | text-to-audio | 8 (one Stability page says 26) |

Check `get_balance` before and after a generation to confirm what you were charged. Balance, account and result
reads are free.

## Quick Start
```bash
STABILITY_API_KEY=sk-... graphrt run stable-audio/example.yaml --plugins .
```
The example prints your credit balance. It is free.

## Usage
```yaml
- id: jingle
  type: stable-audio.text_to_audio
  prompt: "Upbeat dangdut jingle, kendang and suling, 120 BPM"
  duration: 30
  output_format: wav
- id: long_track
  type: stable-audio.text_to_audio_v3
  prompt: "Cinematic ambient score, slow build"
  duration: 300
```
- **Stable Audio 2/2.5 operations:** return `data: {path, bytes, content_type}`.
- **`text_to_audio_v3`:** returns `{job_id, status, result: {audio: "[saved to <path>]", seed, finish_reason},
  saved_files: [{path, bytes, content_type}]}`.
- **Unfinished V3 jobs:** if a job runs past the wait (about 4.75 minutes), the error names the generation id. Call
  `get_audio_result` later instead of generating again.

## Agent policy
- **Agent tools:** all operations, which are paid generations and free reads. Nothing deletes data or moves money.
  `api_request` is GET only for agents.
- **No automatic retries:** generations are never retried after an unknown outcome (5xx or network error). Their
  errors say to check `get_balance` or `get_audio_result` first.

## Errors
- **Error bodies:** errors are read from `{"name", "errors": [...]}` (v2beta) or `{"name", "message"}` (v1).
- **Error kinds:**
  - `unauthorized` becomes `auth_error`.
  - `rate_limit_exceeded` becomes `rate_limited`. The API allows 150 requests per 10 s.
  - `bad_request` becomes `invalid_input`.
  - `content_moderation` (403) becomes `permission_denied`.
- **Other API rejections:** a copyrighted input or an unsupported language returns 422, which becomes
  `invalid_input`.

## Not covered
- **Stable Audio 3 audio-to-audio and inpaint:** not implemented yet. Their request schemas were not verified for this
  version. Stable Audio 2.5 covers both.
- **Stability client headers:** the optional `stability-client-*` headers are not sent.

## Testing
```bash
npm test          # from the repo root
```

## License
Apache-2.0
