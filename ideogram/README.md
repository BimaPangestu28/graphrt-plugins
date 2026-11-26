# ideogram

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the
[Ideogram API v2](https://developer.ideogram.ai/v2/ideogram-api/api-overview): generate images with Ideogram 4.5
(strong typography) and 3.0 (styles), remix, precise-edit, inpaint, reframe, upscale, remove backgrounds and describe
images as structured prompts. Images are saved into a local folder. Built with the
[declarative REST layer](../docs/declarative-plugins.md).

> **Warning:** generation and editing are billed per image from your prepaid Ideogram API balance (see Pricing).

## Features
- **Generate:** `generate_image` (Ideogram 4.5, optionally editing one source image with a mask),
  `generate_image_v3` (Ideogram 3.0 with rendering speed, style type, preset, style codes and a style reference)
- **Edit:** `remix_image`, `precise_edit` (4.5: only the requested change, other pixels copied exactly),
  `inpaint_image`, `reframe_image`, `upscale_image`, `remove_background`
- **Describe:** `describe_image` (image to an Ideogram 4.0 JSON prompt)
- **Read:** `get_generation` (status and images by id), `get_usage` (usage and spend buckets, free)
- **`dry_run`** on every paid image operation: validates and prices the request without generating or billing.
- **`api_request`:** any other endpoint (GET only when called by an agent)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- An Ideogram API account with a payment method and credits (requests get `402` until then)

## Installation
```bash
graphrt plugin install ./ideogram
```

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `IDEOGRAM_API_KEY` | yes | API key from the [API dashboard](https://ideogram.ai/platform) > API Keys (sent as the `Api-Key` header; every key has full access to the API account) |
| `IDEOGRAM_OUTPUT_DIR` | for files | Absolute directory where images are saved. Unset: nothing is downloaded and the result keeps Ideogram's URLs, which expire |
| `IDEOGRAM_UPLOAD_DIR` | for local uploads | Absolute directory that image/mask inputs may be read from. Unset: only https URLs are accepted |

A node may pass `access_token` to use another key; agent tools never can.

## Pricing
Per image, from <https://ideogram.ai/pricing/?pricing_tab=api> (November 2026):

| Operation | Price per image |
|---|---|
| generate_image (4.5) low / medium / high | $0.03 / $0.06 / $0.10 (with a source image: very_low $0.008 ... high $0.22) |
| precise_edit very_low / low / medium / high | $0.008 / $0.03 / $0.06 / $0.22 |
| generate_image_v3, remix_image, inpaint_image, reframe_image: turbo / default / quality | $0.03 / $0.06 / $0.09 |
| upscale_image | by the chosen upscaler (v1 2x upscale $0.06); use `dry_run` |
| remove_background | $0.01 |
| describe_image | $0.01 |

`num_images` multiplies the price. Use `dry_run: true` to get an exact quote first; `get_usage` reports what was spent.

## Usage
```yaml
- id: quote
  type: ideogram.generate_image
  prompt: "A bold poster that says GRAPHRT in hand-lettered type"
  quality: medium
  dry_run: true
- id: poster
  type: ideogram.generate_image
  prompt: "A bold poster that says GRAPHRT in hand-lettered type"
  quality: medium
```

- Image operations return `{result, saved_files}`: `result` is Ideogram's response (`data[]` with `url`, `prompt`,
  `resolution`, `seed`, `is_image_safe`), `saved_files` the downloads. An image that failed the safety check has an
  empty URL: it is not downloaded and appears in `saved_files` as `{image_index, url: null, filtered: true}`.
- Values such as `rendering_speed`, `style_type`, `aspect_ratio` and `quality` are passed through unchanged; see the
  endpoint pages for the accepted values. Each operation takes one source image (and one reference/style
  image); requests with several reference images are not supported yet.
- `remove_background` has a `private` flag to keep the result out of Ideogram's public gallery (default: your plan's
  setting).
- Upload inputs are an https URL (public hosts only) or an absolute path inside `IDEOGRAM_UPLOAD_DIR` (symlinks cannot
  leave it; max 50 MB, less for some endpoints).

## Agent policy
All operations are agent tools: generation and editing are paid writes, allowed by default as the catalog policy
says, with the prices above. Failed writes are never retried automatically. Async mode and webhooks are not
offered. `api_request` is GET-only for agents.

## Errors
| Kind | When |
|---|---|
| `auth_error` | 401, missing or invalid key |
| `permission_denied` | 402 (`insufficient_funds`, `subscription_required`, no payment method) |
| `rate_limited` | 429, `daily_limit`, `inflight_limit` |
| `invalid_input` | 400, 422 prompt failed the safety check |
| `api_error` | 5xx, or a failure reported in a 200 body (`error`) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Api-Key auth, URL downloads, unsafe images, the 402
mapping, error-in-200 bodies and dry runs. Live check: `graphrt run ideogram/example.yaml --plugins .` with an invalid
key returns `auth_error`.

## License
Apache-2.0
