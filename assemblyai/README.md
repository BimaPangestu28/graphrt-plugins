# assemblyai

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the
[AssemblyAI API](https://www.assemblyai.com/docs/api-reference). It does three things:
- uploads audio and transcribes it, waiting for the job, with speaker labels, PII redaction and audio
  intelligence;
- reads transcripts as text, sentences, paragraphs, subtitles and word search results;
- prompts LLMs through the **LLM Gateway**, which replaced LeMUR when LeMUR was shut down on 2026-03-31.

The plugin is declarative ([`definition.mjs`](definition.mjs), see
[docs/declarative-plugins.md](../docs/declarative-plugins.md)). `upload_file` sends the file as the raw request
body (the layer's `bodyMode: "file"`). One time budget covers downloading an https input and uploading it.

## Features
- **`upload_file`:** a local file from `ASSEMBLYAI_UPLOAD_DIR`, or an https URL, up to 200 MB. Returns an
  `upload_url` to pass to `transcribe`.
- **`transcribe`:** starts a transcript and polls every 5 s until it is `completed` or `error`. Set `wait: false`
  to get the id at once.
  - Options: `speech_models` (`assemblyai-stt-3-7` by default, or `universal-2`), language or language detection,
    speaker labels, multichannel, key terms, prompt, sentiment, entities, topics (IAB), key phrases, content safety,
    PII redaction, and an audio start and end.
- **`get_transcript`** and **`list_transcripts`** (last 30 days, newest first, paginated).
- **`get_sentences`**, **`get_paragraphs`**, **`get_subtitles`** (SRT or VTT) and **`search_words`**.
- **`delete_transcript`:** node only.
- **`create_chat_completion`:** LLM Gateway chat (`messages` or `prompt`).
- **`list_llm_models`:** lists the LLM Gateway models. It sends no key, because AssemblyAI's reference marks this
  endpoint as not requiring authentication.
- **`api_request`:** any other endpoint on the API host. GET only for agents.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An AssemblyAI account and API key (billing set up for more than the free credit)

## Installation
```bash
graphrt plugin install ./assemblyai
```
No dependencies.

## Configuration
| Env var | Required | Purpose |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | yes | API key, sent as the bare `Authorization` header |
| `ASSEMBLYAI_REGION` | optional | `us` (default: `api.assemblyai.com`, `llm-gateway.assemblyai.com`) or `eu` (`api.eu.assemblyai.com`, `llm-gateway.eu.assemblyai.com`, which only offers Claude and Gemini) |
| `ASSEMBLYAI_UPLOAD_DIR` | optional | Absolute directory that local files for `upload_file` must be inside (see the note below). Without it only https URLs work, and those are downloaded from public hosts only. |

**`ASSEMBLYAI_UPLOAD_DIR`:** the path is resolved with realpath, so symlinks cannot point outside the directory.
Only regular files up to 200 MB are read.

**Getting a key:** sign up at assemblyai.com and copy the key from the dashboard, under **API Keys**. Keys belong
to a project. An `upload_url` only works with a key from the same project. Data stays in the region of the host
you use.

## Pricing
Transcription and the LLM Gateway are paid, per hour of audio. Prices are from
[assemblyai.com/pricing](https://www.assemblyai.com/pricing), November 2026.

| Item | Price per hour |
|---|---|
| AssemblyAI-STT-3.7 | $0.21 |
| Universal-2 | $0.15 |
| Speaker labels | +$0.02 |
| Sentiment | +$0.02 |
| Entity detection | +$0.08 |
| PII redaction | +$0.08 |
| Topic detection | +$0.15 |
| Content moderation | +$0.15 |
| Key phrases | +$0.01 |
| Key terms prompting | +$0.05 |

- **LLM Gateway:** billed per token at each model's rate.
- **Uploads:** free.
- **Reads:** reads, subtitles and word search are free.

## Quick Start
```bash
ASSEMBLYAI_API_KEY=... graphrt run assemblyai/example.yaml --plugins .
```
The example lists your five newest transcripts. It is free.

## Usage
```yaml
- id: upload
  type: assemblyai.upload_file
  file: /data/audio/interview.mp3          # inside ASSEMBLYAI_UPLOAD_DIR
- id: transcript
  type: assemblyai.transcribe
  audio_url: "{{#upload.data.upload_url#}}"
  speaker_labels: true
  language_code: id
- id: summary
  type: assemblyai.create_chat_completion
  model: gemini-2.5-flash-lite             # see list_llm_models
  messages:
    - { role: user, content: "Summarize this interview: {{#transcript.data.result.text#}}" }
- id: subtitles
  type: assemblyai.get_subtitles
  transcript_id: "{{#transcript.data.job_id#}}"
  subtitle_format: srt
```
- **`transcribe`** returns `data: {job_id, status, result}`, where `result` is the full transcript (`text`,
  `words`, `utterances` and feature results).
- **`get_subtitles`** returns `{text: "<srt or vtt>"}`.
- **`list_transcripts`** returns `transcripts`. Its `next_cursor` points to the next, older page.
- **Long audio:** a transcript can take a few minutes. `transcribe` waits up to about 14.5 minutes, then fails with
  `timeout`. The error names the transcript id, so you can fetch it later with `get_transcript` instead of
  starting a new one.

## Agent policy
- **Tools:** upload, transcription, reads and LLM Gateway calls are tools. Transcription and the LLM Gateway are
  paid.
- **Node only:** `delete_transcript`.
- **`api_request`:** GET only for agents.
- **No retries for `transcribe`:** it starts a job, so it is never retried after an unknown outcome, and its errors
  say to check `list_transcripts`.
- **No retries for LLM Gateway calls:** they are billed per token, so they are never retried after a timeout,
  network error or 5xx. AssemblyAI may already have billed the call, so check the dashboard's usage page.
- **Retries for uploads:** `upload_file` is free and only stores a private copy, so it is retried after a 5xx.
- **Webhooks:** `webhook_url` is not exposed, so transcripts are never pushed to third-party URLs.

## Errors
- Errors are read from `{"error": "..."}`, or `{"message"}` on the LLM Gateway.
- 401 becomes `auth_error`, 404 becomes `not_found` and 429 becomes `rate_limited`.
- A transcript that ends with `status: error` fails with AssemblyAI's reason and the transcript id
  (`retryable: false`).

## Not covered
- **Deprecated:** summarization and auto chapters (use the LLM Gateway) and LeMUR (shut down).
- **Other APIs:** real-time streaming and the Voice Agent API.
- **Options not exposed:** webhooks, custom spelling, language-detection tuning and speaker options.

## Testing
```bash
npm test          # from the repo root
```
- **`test/contract.test.mjs`:** the generated contract suite.
- **`test/plugin.test.mjs`:** the raw upload, the allowlist and symlinks, job polling and failure, EU routing,
  pagination and agent policy.
- **`test/upload-and-paid.test.mjs`:** https inputs and the size cap, upload retries, and no retry for LLM
  Gateway calls.

## License
Apache-2.0
