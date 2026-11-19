# openai

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [OpenAI API](https://platform.openai.com/docs/api-reference).
It is meant for workflows that need a *second* model next to the agent's own: summarize, classify, extract JSON,
embed or moderate text, and run large jobs cheaply through the Batch API. Every request is non-streaming.
Every operation is a workflow node; deletes and batch cancellation are node only.

Built with the declarative REST layer: the whole plugin is the data in [`definition.mjs`](definition.mjs).

## Features
- **Generation:** `create_response` (Responses API: `input`, `instructions`, `reasoning_effort`, JSON schema output
  through `text_format`, tools) and `create_chat_completion` (`messages`, `response_format`, tools)
- **`get_response` / `delete_response`:** stored responses (only when you pass `store: true`; the plugin defaults it
  to `false`)
- **`create_embeddings`:** vectors for up to 2048 texts, optional `dimensions`
- **`create_moderation`:** free harmful-content check (`omni-moderation-latest`)
- **Models:** `list_models`, `get_model`
- **Files:** `list_files` (paginated), `upload_file`, `get_file`, `download_file_content` (saved to disk),
  `delete_file`
- **Batch API:** `create_batch`, `get_batch`, `list_batches`, `cancel_batch`
- **`api_request`:** any other endpoint under `https://api.openai.com/v1` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An OpenAI API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) on an account with
  billing set up. A project key with restricted permissions works: give it Read on Models, Write on Responses /
  Chat completions / Embeddings / Moderations as you need, and Files + Batch for batch workflows.

## Installation
```bash
graphrt plugin install ./openai
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `OPENAI_API_KEY` | yes | API key (`sk-...`), sent as `Authorization: Bearer` |
| `OPENAI_UPLOAD_DIR` | no | Directory `upload_file` may read local files from (absolute path). Without it, `file` must be an https URL |
| `OPENAI_OUTPUT_DIR` | for `download_file_content` | Absolute directory where downloaded file content is saved |
| `OPENAI_TOOL_ALLOW_BATCH` | no | `1` lets agent tools call `create_batch` (off by default: one call can queue thousands of paid requests) |
| `OPENAI_TOOL_ALLOW_REMOTE_TOOLS` | no | `1` lets agent tools pass `mcp` and `connector` tools to `create_response` (off by default: they make OpenAI send the conversation to another server) |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin openai`). Agent tools never can.

## Pricing
Every generation, embedding and batch call is billed per token on your OpenAI account; see
[openai.com/api/pricing](https://openai.com/api/pricing). Batch jobs cost about half of the synchronous price.
Moderation is free. An agent with these tools can spend money: set a usage limit on the project.

## Quick Start
```bash
OPENAI_API_KEY=sk-... graphrt run openai/example.yaml --plugins .
```
The example lists the models your key can use (free).

## Usage
```yaml
- id: summary
  type: openai.create_response
  model: gpt-5-mini
  instructions: Summarize in one sentence.
  input: "{{#start.text#}}"
  max_output_tokens: 300
- id: answer
  type: answer
  answer: "{{#summary.data.output#}}"
```
- The Responses API returns `output` (a list of items); the text is in the `message` item's
  `content[].text`. Reasoning models put a `reasoning` item first, so the message is usually `output.1`
  (`{{#summary.data.output.1.content.0.text#}}`); `output_text` is an SDK helper and is not in the REST response.
  `create_chat_completion` is simpler to template: `{{#chat.data.choices.0.message.content#}}`.
- Structured output: `text_format: {type: json_schema, name: result, schema: {...}, strict: true}`.
- Batch workflow: `upload_file` (purpose `batch`, a .jsonl file) → `create_batch` → poll `get_batch` until
  `completed` → `download_file_content` with its `output_file_id`.
- Generation has a 280 s per-request timeout (not retried) and the plugin a 10 minute host timeout. Agent tool results are cut at
  100,000 characters (embeddings at 20,000; nodes always get everything).

## Agent policy
- **Node only:** `delete_response`, `delete_file`, `cancel_batch`.
- **Opt-in for agents:** `create_batch` needs `OPENAI_TOOL_ALLOW_BATCH=1`; `mcp` and `connector` entries in
  `create_response` `tools` need `OPENAI_TOOL_ALLOW_REMOTE_TOOLS=1`. Workflow nodes are not limited.
- **Retries:** paid calls (`create_response`, `create_chat_completion`, `create_embeddings`) are never retried after
  a 5xx, timeout or network error, because OpenAI may already have billed them; the error says "outcome unknown" and
  to check your usage. 429 rate limits are retried (nothing ran). `upload_file` and `create_batch` are never retried
  after an unknown outcome either. Free calls (moderation, reads) are retried.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | missing or invalid key (`invalid_api_key`) |
| `permission_denied` | the key lacks a permission, or `insufficient_quota` (billing; not retried) |
| `rate_limited` | 429 rate limits (retried with `retry-after`) |
| `invalid_input` | bad parameters (OpenAI's message is included) |
| `not_found` | unknown model, file, response or batch |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus OpenAI-specific cases. Verified live with an invalid
key (clean `auth_error`).

## License
Apache-2.0
