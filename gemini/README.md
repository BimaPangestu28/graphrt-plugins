# gemini

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Gemini API](https://ai.google.dev/api)
(Google AI Studio keys). It is meant for workflows that need a *second* model next to the agent's own: generate or
extract text and JSON, read PDFs, images, audio and video through the Files API, count tokens and embed text.
Requests are non-streaming. Every operation is a workflow node; `delete_file` is node only.

## Features
- **`generate_content`:** `contents`, `system_instruction`, `generation_config` (max tokens, JSON
  `responseMimeType` + `responseSchema`, `thinkingConfig`), `tools` (functions, Google Search), `safety_settings`,
  `cached_content`
- **`count_tokens`:** token count for `contents` (free)
- **Embeddings:** `embed_content` (one text, `task_type`, `output_dimensionality`) and `batch_embed_contents` (up to
  100 texts)
- **Models:** `list_models`, `get_model`
- **Files API:** `upload_file` (Google's resumable upload, from an https URL or an allowed local directory),
  `list_files`, `get_file`, `delete_file`
- **`api_request`:** any other endpoint under `https://generativelanguage.googleapis.com/v1beta` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Keys created in Google
  Cloud work too when the "Generative Language API" is enabled and the key is not restricted to other APIs.

## Installation
```bash
graphrt plugin install ./gemini
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `GEMINI_API_KEY` | yes | API key, sent as the `x-goog-api-key` header (never in the URL) |
| `GEMINI_TOOL_ALLOW_URL_CONTEXT` | no | `1` lets agent tools pass the `urlContext` tool to `generate_content` (off by default: it makes Google fetch URLs from the prompt) |
| `GEMINI_UPLOAD_DIR` | no | Directory `upload_file` may read local files from (absolute path). Without it, `file` must be an https URL |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin gemini`). Agent tools never can.

## Pricing
The free tier has low rate limits, and Google may use free-tier prompts to improve its products. With billing
enabled, generation and embeddings are billed per token; see
[ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing). Token counting, model
listing and file storage are free. An agent with these tools can spend money on a billed project.

## Quick Start
```bash
GEMINI_API_KEY=... graphrt run gemini/example.yaml --plugins .
```
The example lists the models your key can use (free).

## Usage
```yaml
- id: extract
  type: gemini.generate_content
  model: gemini-2.5-flash
  contents:
    - role: user
      parts: [{ text: "Extract the invoice number and total from: {{#start.text#}}" }]
  generation_config:
    responseMimeType: application/json
    responseSchema: { type: object, properties: { number: { type: string }, total: { type: number } } }
- id: answer
  type: answer
  answer: "{{#extract.data.candidates.0.content.parts.0.text#}}"
```
- Model ids have no `models/` prefix (`gemini-2.5-flash`); `list_models` shows them as `models/<id>`.
- A blocked prompt returns 200 with `promptFeedback.blockReason` and no candidates; a stopped answer has
  `finishReason` other than `STOP` (`MAX_TOKENS`, `SAFETY`, ...).
- Files: `upload_file` → wait until `get_file` shows `state: ACTIVE` (video takes a while) → pass
  `{fileData: {fileUri: <uri>, mimeType: <mimeType>}}` as a part. Files are deleted after 48 hours.
- Generation has a 280 s per-request timeout (not retried) and the plugin a 10 minute host timeout. Agent tool results are cut at
  100,000 characters (embeddings at 20,000); nodes always get everything.

## Agent policy
- **Node only:** `delete_file`.
- **Opt-in for agents:** a `urlContext` tool in `generate_content` needs `GEMINI_TOOL_ALLOW_URL_CONTEXT=1`. Workflow
  nodes are not limited.
- **Retries:** `generate_content`, `embed_content` and `batch_embed_contents` are paid (on a billed project) and are
  never retried after a 5xx, timeout or network error, because Google may already have billed them; the error says
  "outcome unknown" and to check usage. 429 is retried: nothing ran. `count_tokens` and reads are retried.
  `upload_file` is never retried once the bytes were sent; its error says how to check.
- `upload_file` reads local files only inside `GEMINI_UPLOAD_DIR` (symlinks resolved), downloads https URLs only
  from public hosts, and sends the bytes only to Google's own upload URL.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | missing, invalid or expired key (`API_KEY_INVALID`, sent by Google as a 400) |
| `permission_denied` | API not enabled for the key's project, key restricted, region not supported |
| `rate_limited` | 429 `RESOURCE_EXHAUSTED` (free tier limits are low) |
| `invalid_input` | bad request (Google's message is included) |
| `not_found` | unknown model or file |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Gemini-specific cases; `test/upload-file.test.mjs`
covers the hand-written resumable upload. Verified live with an invalid key (clean `auth_error`).

## Changelog
### 0.1.0 (unreleased)
- **Breaking:** `embed_content` parameter `title` is now `document_title` (still sent to Gemini as `title`). graphrt takes `title` from every workflow node, so the old name was silently dropped on nodes; tool calls that passed `title` must use `document_title`.

## License
Apache-2.0
