# groq

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, but the live check was blocked by Groq's network filter (403) before the key was checked. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the OpenAI-compatible
[Groq API](https://console.groq.com/docs/api-reference). Groq serves open models (Llama, GPT-OSS, Qwen, Whisper and
more) at very high speed, which suits workflows that need a fast *second* model: classify, extract, summarize,
transcribe calls, speak text, or run large jobs through the Batch API. Requests are non-streaming. Every operation is
a workflow node; deletes and batch cancellation are node only.

## Features
- **`create_chat_completion`:** `messages`, `response_format` (JSON mode, JSON schema), `tools`, `reasoning_effort`
  and `reasoning_format` for reasoning models
- **Audio:** `transcribe_audio` (Whisper, any language), `translate_audio` (to English) from a file or a public
  `url`; `create_speech` (text to speech, saved to disk)
- **Models:** `list_models`, `get_model`
- **Files:** `list_files`, `upload_file`, `get_file`, `download_file_content` (saved to disk), `delete_file`
- **Batch API:** `create_batch`, `get_batch`, `list_batches`, `cancel_batch`
- **`api_request`:** any other endpoint under `https://api.groq.com/openai/v1` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Groq API key from [console.groq.com/keys](https://console.groq.com/keys). Batch and some models need a paid
  (Developer) plan; text to speech models may require accepting their terms in the console first.
- Groq blocks some networks and regions at the edge (403 "Access denied. Please check your network settings.").

## Installation
```bash
graphrt plugin install ./groq
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `GROQ_API_KEY` | yes | API key (`gsk_...`), sent as `Authorization: Bearer` |
| `GROQ_UPLOAD_DIR` | no | Directory audio and batch files may be read from (absolute path). Without it, `file` must be an https URL |
| `GROQ_TOOL_ALLOW_BATCH` | no | `1` lets agent tools call `create_batch` (off by default: one call can queue thousands of paid requests) |
| `GROQ_OUTPUT_DIR` | for `create_speech`, `download_file_content` | Absolute directory where audio and file content are saved |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin groq`). Agent tools never can.

## Pricing
The free plan has per-model rate limits and no charge. On the Developer plan, chat is billed per token,
transcription per audio hour and speech per character; batches get a discount. See
[groq.com/pricing](https://groq.com/pricing). An agent with these tools can spend money on a paid plan.

## Quick Start
```bash
GROQ_API_KEY=gsk_... graphrt run groq/example.yaml --plugins .
```
The example lists the available models (free).

## Usage
```yaml
- id: transcript
  type: groq.transcribe_audio
  file: "{{#start.recording_url#}}"
  language: id
- id: summary
  type: groq.create_chat_completion
  model: llama-3.3-70b-versatile
  messages:
    - { role: system, content: Summarize the call in three bullet points. }
    - { role: user, content: "{{#transcript.data.text#}}" }
- id: answer
  type: answer
  answer: "{{#summary.data.choices.0.message.content#}}"
```
- `file` is an https URL (downloaded by the plugin, public hosts only) or an absolute path inside `GROQ_UPLOAD_DIR`;
  `url` instead lets Groq fetch the audio itself. Audio files are limited to 25 MB.
- Model ids with a slash (`openai/gpt-oss-120b`) work as `model` in the body; `get_model` sends them as one encoded
  path segment (`/models/openai%2Fgpt-oss-120b`), exactly like the official groq-python SDK.
- Batch workflow: `upload_file` → `create_batch` → poll `get_batch` → `download_file_content` with `output_file_id`.
- Generation has a 280 s per-request timeout (not retried) and the plugin a 10 minute host timeout. Agent tool results are cut at
  100,000 characters; nodes always get everything.

## Agent policy
- **Node only:** `delete_file`, `cancel_batch`.
- **Opt-in for agents:** `create_batch` needs `GROQ_TOOL_ALLOW_BATCH=1`. Workflow nodes are not limited.
- **Retries:** chat, transcription, translation and speech are paid (on the Developer plan) and are never retried
  after a 5xx, timeout or network error, because Groq may already have billed them; the error says "outcome unknown"
  and to check usage. 429 is retried: nothing ran. `upload_file` and `create_batch` are never retried after an
  unknown outcome either. Reads are retried.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | missing or invalid key (`invalid_api_key`) |
| `permission_denied` | 403: plan or model access, or Groq's network block |
| `rate_limited` | 429 rate limits (retried with `retry-after`) |
| `invalid_input` | bad parameters, model decommissioned (Groq's message is included) |
| `not_found` | unknown model, file or batch |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Groq-specific cases. The live check from this
development network got Groq's edge block (403 `permission_denied`, "Access denied. Please check your network
settings.") before any key check, so the auth mapping is verified only by the contract tests.

## License
Apache-2.0
