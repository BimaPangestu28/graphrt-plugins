# openai-images

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[OpenAI Images API](https://developers.openai.com/api/reference/resources/images): generate images from a prompt
and edit images (with an optional mask, or from several reference images) with the GPT Image models
(`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest`, the 2.5/2.6 models) and DALL·E.
Generated images are saved into a local folder. Built with the
[declarative REST layer](../docs/declarative-plugins.md).

> **Warning:** generations and edits are billed to your OpenAI account on every call (see Pricing).

## Features
- **`generate_image`:** prompt to 1–10 images; size, quality, background (transparent), output format and
  compression, moderation level. DALL·E 3 `style` and `response_format` for the legacy models.
- **`edit_image`:** edit one uploaded image, optionally only where a PNG `mask` is transparent. Without a mask and
  with a prompt such as "a variation of this image" it replaces the retired variations endpoint.
- **`edit_image_from_references`:** edit or combine up to 16 images given as URLs, `data:` URLs or uploaded
  `file_id`s (JSON form of the edits endpoint, GPT Image models only).
- **`list_models`:** the models your key can use (free).
- **`api_request`:** any other endpoint (GET only when called by an agent).

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An OpenAI API key on a project with billing; GPT Image models may require
  [organization verification](https://help.openai.com/en/articles/10910291-api-organization-verification)

## Installation
```bash
graphrt plugin install ./openai-images
```

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | API key from <https://platform.openai.com/api-keys> (a project key limits it to one project) |
| `OPENAI_IMAGES_OUTPUT_DIR` | for files | Absolute directory where generated images are saved. Unset: nothing is saved and the result keeps the raw `b64_json` (large) |
| `OPENAI_IMAGES_UPLOAD_DIR` | for local uploads | Absolute directory that `edit_image` may read local files from. Unset: only https URLs are accepted |

A node may pass `access_token` to use another key; agent tools never can.

## Pricing
Billed per token by OpenAI (standard tier, per 1M tokens, November 2026):

| Model | Image input | Image output | Text input |
|---|---:|---:|---:|
| gpt-image-2 (and 2.5 / 2.6 variants) | $8.00 | $30.00 | $5.00 |
| gpt-image-1.5 / chatgpt-image-latest | $8.00 | $32.00 | $5.00 |
| gpt-image-1-mini | $2.50 | $8.00 | $2.00 |

Output tokens grow with size and quality: a `high` quality 1024x1024 image costs several times a `low` one, and
`n: 4` costs four images. DALL·E is priced per image. Check <https://developers.openai.com/api/docs/pricing> and the
calculator in the image generation guide for current numbers; the `usage` field of each result reports the tokens.

## Usage
```yaml
- id: hero
  type: openai-images.generate_image
  prompt: "Flat illustration of a lighthouse at dawn, warm colours"
  size: 1536x1024
  quality: medium
  output_format: webp
- id: tweak
  type: openai-images.edit_image
  image: "{{#hero.data.saved_files.0.path#}}"   # needs OPENAI_IMAGES_UPLOAD_DIR to include the output dir
  prompt: "Add a small sailboat on the left"
```

- `data` of generate/edit is `{result, saved_files}`: `result` is OpenAI's response with each `b64_json` replaced by
  `"[saved to <path>]"`, `saved_files` lists `{path, bytes, content_type}` (or `{source | url, error}` when one could
  not be saved). DALL·E URLs expire after 60 minutes; they are downloaded right away.
- Upload inputs (`image`, `mask`) are an https URL (public hosts only, downloaded with size limits) or an absolute
  path inside `OPENAI_IMAGES_UPLOAD_DIR` (symlinks cannot leave it; max 50 MB).
- Generation can take up to two minutes for `high` quality; each request may take up to 300 s.

## Agent policy
All operations are agent tools: generation is a paid write, allowed by default as the catalog policy says, with the
price above. A failed generation is never retried automatically (the outcome may be unknown and a retry would bill
again). Tool results are truncated to 20,000 characters; nodes get the full result. `api_request` is GET-only for
agents.

## Errors
| Kind | When |
|---|---|
| `auth_error` | 401, invalid or revoked key (`invalid_api_key`) |
| `permission_denied` | 403 (e.g. organization not verified for GPT Image), `insufficient_quota`, billing limit reached |
| `invalid_input` | 400 bad parameter, `moderation_blocked` / `content_policy_violation`, upload refused before sending |
| `rate_limited` | 429 rate limit (retried with backoff for reads) |
| `api_error` | 5xx; for generations the error says the outcome is unknown and is not retryable |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus base64 saving, moderation and quota mapping and the
upload allowlist. Live check: `graphrt run openai-images/example.yaml --plugins .` with an invalid key returns
`auth_error`.

## License
Apache-2.0
