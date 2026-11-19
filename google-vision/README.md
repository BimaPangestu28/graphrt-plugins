# google-vision

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for
[Google Cloud Vision](https://cloud.google.com/vision/docs/reference/rest) with an API key. It reads text from images
(OCR), labels what an image shows, finds faces and their expressions, rates images for unsafe content, and runs any
other Vision feature (logos, landmarks, objects, colors, web matches). Every operation is a workflow node and an
agent tool.

## Features
- **`detect_text`:** OCR → `{text, locale}`; `mode: dense` (documents, photos of pages; default) or `sparse` (signs,
  labels), optional `language_hints`
- **`detect_labels`:** `[{label, score, topicality, mid}]`
- **`detect_faces`:** bounding boxes and joy/sorrow/anger/surprise likelihoods (no identity recognition);
  `include_landmarks` for the facial points
- **`detect_safe_search`:** adult, spoof, medical, violence and racy likelihoods
- **`analyze_image`:** several `features` at once, returns Vision's response for the image
- **Batch pass-throughs:** `annotate_images` (up to 16 images, Vision's own request format; agents may send only
  inline `content` or `gs://` images) and `annotate_files` (OCR of one inline PDF/TIFF/GIF, up to 5 pages)

The one-image operations take `image` as an https URL, a `gs://` URI or a local file, or `image_base64`. They are
hand-written (`lib/image-operations.mjs`) because the image has to be read and sent as base64 inside the JSON body,
which the declarative layer cannot do. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with billing and the **Cloud Vision API** enabled
- An API key ([console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)),
  ideally restricted to the Cloud Vision API. `gs://` images need the bucket to be readable by the project.

## Installation
```bash
graphrt plugin install ./google-vision
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `GOOGLE_VISION_API_KEY` | yes | API key, sent as `x-goog-api-key` (never in the URL) |
| `GOOGLE_VISION_UPLOAD_DIR` | no | Directory `image` may read local files from (absolute path). Without it, `image` must be a URL or `gs://` URI |

A node can override the key with `access_token` (from a secret; needs `--trust-plugin google-vision`). Agent tools
never can.

## Pricing
Billed per image per feature ("unit"), with the first 1,000 units a month free; see
[cloud.google.com/vision/pricing](https://cloud.google.com/vision/pricing). `analyze_image` with three features
costs three units. An agent with these tools can spend money: set a quota on the API in the Cloud console.

## Quick Start
```bash
GOOGLE_VISION_API_KEY=... graphrt run google-vision/example.yaml --plugins .
```
The example labels a public sample photo (one unit).

## Usage
```yaml
- id: receipt
  type: google-vision.detect_text
  image: "{{#start.receipt_url#}}"
- id: answer
  type: answer
  answer: "{{#receipt.data.text#}}"
```
- https images are downloaded by the plugin, not by Google: only public hosts (no localhost, private or metadata
  addresses, checked on every redirect), at most 7 MB (Vision's 10 MB JSON limit after base64). Local files must be
  inside `GOOGLE_VISION_UPLOAD_DIR` (symlinks resolved).
- A per-image error (for example "Bad image data") fails the one-image operations with Vision's message; in the
  batch operations it stays inside `responses[i].error`.
- Agent tool results are cut to 50 items and 100,000 characters; nodes always get everything.

## Agent policy
All operations are agent tools; Vision stores nothing. **Retries:** every call is billed per image and feature, so
none is retried after a 5xx, timeout or network error (Google may already have billed it); the error says "outcome
unknown" and to check usage. 429 is retried: nothing ran. For agents, `annotate_images` refuses an http(s)
`imageUri` (Google would fetch a URL the agent picked); the one-image operations download https images themselves
with public-host checks. There is no `api_request`.

## Errors
| Kind | When |
|------|------|
| `auth_error` | invalid or expired key (`API_KEY_INVALID`, sent by Google as a 400) |
| `permission_denied` | the API is not enabled, billing is off, the key is restricted, or a `gs://` object is not readable |
| `invalid_input` | no image or both image kinds, a refused file or URL, an image over 7 MB, "Bad image data" |
| `permission_denied` (agents) | an http(s) `imageUri` in `annotate_images` |
| `rate_limited` | 429 quota exceeded (retried) |
| `api_error` | the image could not be downloaded, or a Vision server error |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for the batch operations;
`test/image-operations.test.mjs` covers the hand-written image operations. Verified live with an invalid key: the
sample image was downloaded and Vision answered with a clean `auth_error`.

## License
Apache-2.0
