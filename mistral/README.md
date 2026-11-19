# mistral

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Mistral AI API](https://docs.mistral.ai/api).
It is meant for workflows that need a *second* model next to the agent's own: chat and code completion, embeddings,
moderation, and Mistral OCR to turn PDFs and images into markdown. Requests are non-streaming. Every operation is a
workflow node; deletes and batch cancellation are node only.

## Features
- **`create_chat_completion`:** `messages`, `response_format` (JSON mode, JSON schema), `tools`, `safe_prompt`
- **`create_fim_completion`:** Codestral fill-in-the-middle (`prompt` + `suffix`)
- **`create_embeddings`:** `mistral-embed` or `codestral-embed` (with `output_dimension`, `output_dtype`)
- **Moderation:** `moderate_text` (texts) and `moderate_chat` (the last message in its conversation)
- **`ocr_document`:** a PDF or image (URL, data URL or uploaded file id) to markdown per page, with tables, headers,
  footers and an optional JSON-schema `document_annotation_format`
- **Models:** `list_models`, `get_model`
- **Files:** `list_files` (paginated), `upload_file`, `get_file`, `download_file_content` (saved to disk),
  `delete_file`
- **Batch jobs:** `create_batch_job` (files or inline requests), `get_batch_job`, `list_batch_jobs`,
  `cancel_batch_job`
- **`api_request`:** any other endpoint on `https://api.mistral.ai` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Mistral API key from [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) on a workspace with a
  plan (the free "Experiment" plan works with low rate limits).

## Installation
```bash
graphrt plugin install ./mistral
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `MISTRAL_API_KEY` | yes | API key, sent as `Authorization: Bearer` |
| `MISTRAL_UPLOAD_DIR` | no | Directory `upload_file` may read local files from (absolute path). Without it, `file` must be an https URL |
| `MISTRAL_TOOL_ALLOW_BATCH` | no | `1` lets agent tools call `create_batch_job` (off by default: one call can queue thousands of paid requests) |
| `MISTRAL_OUTPUT_DIR` | for `download_file_content` | Absolute directory where file content is saved |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin mistral`). Agent tools never can.

## Pricing
Chat, FIM and embeddings are billed per token, OCR per page, and batch jobs at about half price; see
[mistral.ai/pricing](https://mistral.ai/pricing#api-pricing). An agent with these tools can spend money on a paid
plan.

## Quick Start
```bash
MISTRAL_API_KEY=... graphrt run mistral/example.yaml --plugins .
```
The example lists the models your key can use (free).

## Usage
```yaml
- id: ocr
  type: mistral.ocr_document
  document: { type: document_url, document_url: "{{#start.pdf_url#}}" }
- id: fields
  type: mistral.create_chat_completion
  model: mistral-small-latest
  response_format: { type: json_object }
  messages:
    - { role: system, content: "Return JSON with invoice_number and total." }
    - { role: user, content: "{{#ocr.data.pages.0.markdown#}}" }
```
- `ocr_document` returns `pages[].markdown`; set `include_image_base64: true` only when you need the images (the
  response gets large).
- Batch workflow: `upload_file` (purpose `batch`) → `create_batch_job` → poll `get_batch_job` until `SUCCESS` →
  `download_file_content` with its `output_file`.
- Generation and OCR have a 280 s per-request timeout (not retried) and the plugin a 10 minute host timeout. Agent tool results are
  cut at 100,000 characters (embeddings at 20,000); nodes always get everything.

## Agent policy
- **Node only:** `delete_file`, `cancel_batch_job`.
- **Opt-in for agents:** `create_batch_job` needs `MISTRAL_TOOL_ALLOW_BATCH=1`. Workflow nodes are not limited.
- **Retries:** chat, FIM, embeddings, moderation and OCR are paid and are never retried after a 5xx, timeout or
  network error, because Mistral may already have billed them; the error says "outcome unknown" and to check usage.
  429 is retried: nothing ran. `upload_file` and `create_batch_job` are never retried after an unknown outcome
  either. Reads are retried.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | missing or invalid key (401) |
| `permission_denied` | the plan or key cannot use the model or endpoint |
| `rate_limited` | 429 rate limits (retried with `retry-after`) |
| `invalid_input` | 400/422 validation errors (Mistral's detail is included) |
| `not_found` | unknown model, file or job |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Mistral-specific cases. Verified live with an invalid
key (clean `auth_error`).

## License
Apache-2.0
