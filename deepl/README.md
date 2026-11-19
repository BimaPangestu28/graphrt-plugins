# deepl

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [DeepL API](https://developers.deepl.com/api-reference).
It translates and rephrases text, translates whole documents, and reads usage, supported languages and glossaries.
Every operation is a workflow node and an agent tool; `download_document` is never retried because DeepL allows
only one download.

## Features
- **`translate_text`:** up to 50 texts per call with `target_lang`, optional `source_lang`, `context` (not billed),
  `formality`, `model_type`, `glossary_id`, `tag_handling` (xml/html), `custom_instructions`
- **`rephrase_text`:** DeepL Write, with `writing_style` or `tone` (Pro plans)
- **`get_usage`:** characters used and the limit for this billing period
- **`list_languages`:** source or target languages
- **Glossaries (read):** `list_glossaries`, `get_glossary`, `get_glossary_entries` (v3 multilingual glossaries)
- **Documents:** `translate_document` (upload) → `get_document_status` → `download_document` (saved to disk)
- **`api_request`:** any other endpoint (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A DeepL API plan (API Free or API Pro; a DeepL "Pro" subscription for the apps is not an API plan) and its key
  from [deepl.com/your-account/keys](https://www.deepl.com/your-account/keys). Free keys end in `:fx`.

## Installation
```bash
graphrt plugin install ./deepl
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `DEEPL_API_KEY` | yes | API key, sent as `Authorization: DeepL-Auth-Key <key>`. A key ending in `:fx` selects `api-free.deepl.com` |
| `DEEPL_API_URL` | no | Override the host (must be a `deepl.com` host), e.g. `https://api-free.deepl.com` |
| `DEEPL_UPLOAD_DIR` | no | Directory `translate_document` may read local files from (absolute path). Without it, `file` must be an https URL |
| `DEEPL_OUTPUT_DIR` | for `download_document` | Absolute directory where translated documents are saved |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin deepl`); the host is still
chosen from `DEEPL_API_KEY`/`DEEPL_API_URL`. Agent tools never can.

## Pricing
API Free: 500,000 characters a month at no cost. API Pro: a monthly base fee plus a price per million characters;
documents are billed by their characters with a minimum per document (see
[deepl.com/pro-api](https://www.deepl.com/pro-api)). `context` is not billed. An agent with `translate_text` can use
up the quota; `get_usage` shows where you stand.

## Quick Start
```bash
DEEPL_API_KEY=...:fx graphrt run deepl/example.yaml --plugins .
```
The example shows the characters used this period (free).

## Usage
```yaml
- id: translated
  type: deepl.translate_text
  text: ["{{#start.message#}}"]
  target_lang: EN-US
  context: Customer support chat
- id: answer
  type: answer
  answer: "{{#translated.data.translations.0.text#}} (from {{#translated.data.translations.0.detected_source_language#}})"
```
- Target codes are like `EN-US`, `EN-GB`, `PT-BR`, `DE`, `ID`; source codes have no variant (`EN`).
- A glossary needs `source_lang`. Glossary writes (create, edit, delete) are not offered; manage glossaries in the
  DeepL account or through a node with `api_request`.
- Documents: `translate_document` returns `document_id` and `document_key` → poll `get_document_status` until
  `status: done` → `download_document`. The result can be downloaded once.

## Agent policy
All operations are agent tools. **Retries:** `translate_text` and `rephrase_text` are billed per character and are
never retried after a 5xx, timeout or network error, because DeepL may already have counted the characters; the
error says "outcome unknown" and to compare `get_usage`. 429/529 are retried: nothing ran. `translate_document` and
`download_document` are never retried after an unknown outcome either. Reads and `get_document_status` are retried.
`api_request` is GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | 403: invalid key, or a free key on the Pro host (set `DEEPL_API_URL` or use the `:fx` key) |
| `permission_denied` | 456: the character quota is used up (not retried) |
| `rate_limited` | 429 / 529: too many requests (retried) |
| `invalid_input` | bad language code or parameters (DeepL's message is included) |
| `not_found` | unknown glossary or document |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus DeepL-specific cases. Verified live with invalid
free and Pro keys (clean `auth_error`).

## License
Apache-2.0
