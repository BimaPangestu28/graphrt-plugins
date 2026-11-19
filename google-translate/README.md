# google-translate

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for
[Google Cloud Translation - Basic (v2)](https://cloud.google.com/translate/docs/reference/rest/v2/translate). It
translates texts, detects their language and lists supported languages. Every operation is a workflow node and an
agent tool.

**Why v2 with an API key:** it is the simplest official auth that works: one API key, sent as the
`x-goog-api-key` header (never in the URL). Cloud Translation v3 (Advanced: glossaries, custom models, document
translation) needs a project id and an OAuth access token from a service account, which this plugin layer does not
mint. For glossaries and documents, see the [deepl](../deepl/) plugin. v2 has exactly these three methods, so the
plugin is small on purpose.

## Features
- **`translate_text`:** up to 128 texts into one `target` language, optional `source`, `format` (text or html),
  `model` (nmt or base); returns `[{translatedText, detectedSourceLanguage}]`
- **`detect_language`:** `[{language, confidence}]` candidates per text
- **`list_languages`:** codes and names (named in `display_language`)
- **`api_request`:** any other v2 endpoint (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with billing and the **Cloud Translation API** enabled
- An API key ([console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)),
  ideally restricted to the Cloud Translation API

## Installation
```bash
graphrt plugin install ./google-translate
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `GOOGLE_TRANSLATE_API_KEY` | yes | API key, sent as `x-goog-api-key` |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin google-translate`). Agent
tools never can.

## Pricing
Billed per character sent (translation and detection), with a monthly free allowance; see
[cloud.google.com/translate/pricing](https://cloud.google.com/translate/pricing). Listing languages is free. An agent
with these tools can spend money: set a quota on the API in the Cloud console.

## Quick Start
```bash
GOOGLE_TRANSLATE_API_KEY=... graphrt run google-translate/example.yaml --plugins .
```
The example lists the supported languages (free).

## Usage
```yaml
- id: translated
  type: google-translate.translate_text
  text: ["{{#start.review#}}"]
  target: en
- id: answer
  type: answer
  answer: "{{#translated.data.0.translatedText#}} ({{#translated.data.0.detectedSourceLanguage#}})"
```
- With `format: text` (the default) the result is plain text; with `html`, markup is kept and the text is HTML
  escaped.

## Agent policy
All operations are agent tools. **Retries:** `translate_text` and `detect_language` are billed per character and are
never retried after a 5xx, timeout or network error, because Google may already have billed them; the error says
"outcome unknown" and to check usage. 429 is retried: nothing ran. `list_languages` is retried. `api_request` is
GET-only for agents.

## Errors
| Kind | When |
|------|------|
| `auth_error` | invalid or expired key (`API_KEY_INVALID`, sent by Google as a 400) |
| `permission_denied` | the API is not enabled, billing is off, or the key is restricted to other APIs |
| `rate_limited` | 429 quota exceeded (retried) |
| `invalid_input` | bad language code or too much text (Google's message is included) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Translation-specific cases. Verified live with an
invalid key (clean `auth_error`).

## License
Apache-2.0
