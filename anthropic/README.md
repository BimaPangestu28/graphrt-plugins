# anthropic

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Claude API](https://platform.claude.com/docs/en/api).
It is meant for workflows that need a *second* model next to the agent's own: ask Claude to summarize, classify,
extract or review, count tokens before a big request, and run large jobs at half price through Message Batches.
Requests are non-streaming. Every operation is a workflow node; cancels and deletes are node only.

The plugin sends `anthropic-version: 2026-10-21`, the current API version. On that version a Messages request may
not send `temperature`, `top_p` or `top_k`, so the plugin does not offer them; steer output with the prompt and
`output_config.effort` instead.

## Features
- **`create_message`:** Messages API with `messages`, `system`, `tools`, `tool_choice`, `thinking`, `output_config`
  (`effort`, structured `format`), `stop_sequences`. Defaults: `model: claude-opus-5-5`, `max_tokens: 16000`
- **`count_tokens`:** input token count for the same request shape (free)
- **Models:** `list_models` (with `max_input_tokens`, `max_tokens`, `capabilities`), `get_model`
- **Message Batches:** `create_message_batch` (up to 100,000 requests), `get_message_batch`,
  `list_message_batches`, `get_message_batch_results` (streamed JSON Lines up to 100 MB, filter by `result_type`
  or `custom_ids`, page with `offset`),
  `cancel_message_batch`, `delete_message_batch`
- **Files API:** `upload_file`, `list_files`, `get_file`, `delete_file`
- **`api_request`:** any other endpoint on `https://api.anthropic.com` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Claude API key from the [Claude Console](https://platform.claude.com/settings/keys) on an organization with
  credits or billing set up. Keys belong to a workspace; files and batches are scoped to it.

## Installation
```bash
graphrt plugin install ./anthropic
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `ANTHROPIC_API_KEY` | yes | API key (`sk-ant-...`), sent as `x-api-key` |
| `ANTHROPIC_TOOL_ALLOW_BATCH` | no | `1` lets agent tools call `create_message_batch` (off by default: one call can queue 100,000 paid requests) |
| `ANTHROPIC_UPLOAD_DIR` | no | Directory `upload_file` may read local files from (absolute path). Without it, `file` must be an https URL |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin anthropic`). Agent tools never can.

## Pricing
Messages and batches are billed per input and output token on your organization; see
[claude.com/pricing#api](https://claude.com/pricing#api). Message Batches cost 50% of the standard price. Token
counting is free. Opus 5.5 is the default model; pass `model: claude-haiku-5-5` for cheap high-volume steps. An
agent with these tools can spend money: set a spend limit on the workspace.

## Quick Start
```bash
ANTHROPIC_API_KEY=sk-ant-... graphrt run anthropic/example.yaml --plugins .
```
The example lists the models your key can use (free).

## Usage
```yaml
- id: review
  type: anthropic.create_message
  system: You review support replies. Answer APPROVE or REJECT with one reason.
  messages: [{ role: user, content: "{{#start.draft#}}" }]
  max_tokens: 1000
  output_config: { effort: low }
- id: answer
  type: answer
  answer: "{{#review.data.content#}}"
```
- The reply is a list of content blocks; with thinking on (the default on current models) a `thinking` block comes
  first, so read the block with `type: text`. Always check `stop_reason`: `refusal` means the model declined and
  `max_tokens` means the answer was cut.
- Batches: `create_message_batch` → poll `get_message_batch` until `processing_status` is `ended` →
  `get_message_batch_results`. Results come in any order: match them by `custom_id`.
- Generation has a 280 s per-request timeout and the plugin a 10 minute host timeout. Agent tool results are cut at
  100,000 characters (batch results to 100 items: use `offset` 100, 200, ... for the rest); nodes always get
  everything.

## Agent policy
- **Node only:** `cancel_message_batch`, `delete_message_batch`, `delete_file`.
- **Opt-in for agents:** `create_message_batch` needs `ANTHROPIC_TOOL_ALLOW_BATCH=1`. Workflow nodes are not limited.
- **Retries:** `create_message` is paid and is never retried after a 5xx, timeout or network error, because Claude
  may already have billed it; the error says "outcome unknown" and to check usage. 429 and 529 (overloaded) are
  retried: nothing ran. `create_message_batch` and `upload_file` are never retried after an unknown outcome either.
  Free calls (`count_tokens`, reads) are retried.
- `api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | missing or invalid key (`authentication_error`) |
| `permission_denied` | `permission_error`, or `billing_error` (no credits) |
| `rate_limited` | `rate_limit_error` (429) and `overloaded_error` (529), retried |
| `api_error` | 5xx (not retried for `create_message`), or batch results over 100 MB (filter them) |
| `invalid_input` | `invalid_request_error`, `request_too_large` (Claude's message is included) |
| `not_found` | unknown model, batch or file |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Claude-specific cases; `test/batch-results.test.mjs`
covers the hand-written JSONL results operation. Verified live with an invalid key (clean `auth_error`).

## License
Apache-2.0
