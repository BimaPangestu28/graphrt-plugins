# google-imagen

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Google image generation through the Gemini API.

**Imagen is shut down in the Gemini API** ([notice](https://aistudio.google.com/docs/imagen)): the `:predict`
endpoint with `imagen-*` models no longer works. Google's replacement is native image output of the Gemini image
models ("Nano Banana": `gemini-nano-banana-2.1`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`,
`gemini-3-pro-image`, `gemini-2.5-flash-image`), which this plugin uses through the
[Interactions API](https://aistudio.google.com/api-reference/interactions-api) (Google's recommended API; the
older `generateContent` is legacy). The plugin keeps the `google-imagen` name from the catalog. Built with the
[declarative REST layer](../docs/declarative-plugins.md) plus one hand-written operation (`edit_image`).

> **Warning:** image generation and editing are billed per image to your Google Cloud billing account (see Pricing).

## Features
- **`generate_image`:** prompt to image, with aspect ratio (1:1 ... 21:9, plus 1:4, 4:1, 1:8, 8:1 on Nano Banana 2.1
  and 3.1 Flash) and size (512, 1K, 2K, 4K). `previous_interaction_id` continues an earlier interaction, so you can
  edit its image conversationally without uploading it again.
- **`edit_image`:** edit or combine up to 14 input images (https URLs or local files) with a prompt.
- **`create_interaction`:** low-level call with your own content blocks (text, base64 images, Files API URIs).
- **`get_interaction`**, **`list_models`**, **`get_model`:** reads (free). **`delete_interaction`:** node only.
- **`api_request`:** any other Gemini API endpoint (GET only when called by an agent)

Every generated image carries Google's invisible SynthID watermark.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Gemini API key on a project with billing (image models are not on the free tier)

## Installation
```bash
graphrt plugin install ./google-imagen
```

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | API key from <https://aistudio.google.com/apikey> (sent as `x-goog-api-key`) |
| `GOOGLE_IMAGEN_OUTPUT_DIR` | for files | Absolute directory where generated images are saved; each base64 image in the result is replaced by `"[saved to <path>]"`. Unset: nothing is saved and the result keeps the base64 (large) |
| `GOOGLE_IMAGEN_UPLOAD_DIR` | for local inputs | Absolute directory that `edit_image` may read local images from. Unset: only https URLs are accepted |

A node may pass `access_token` to use another key; agent tools never can.

## Pricing
Image output, standard tier, from <https://aistudio.google.com/docs/pricing> (November 2026):

| Model | Per image |
|---|---|
| gemini-nano-banana-2.1 | $0.0336 (1K), $0.0504 (2K), $0.113 (4K) |
| gemini-3.1-flash-image | $0.045 (512), $0.067 (1K), more for 2K/4K |
| gemini-3-pro-image | $0.134 (1K/2K), more for 4K |

Input text and images are billed as tokens on top (small). Check the pricing page for the current numbers and for
the other models.

## Usage
```yaml
- id: poster
  type: google-imagen.generate_image
  prompt: "A vintage travel poster of Bandung with bold lettering"
  aspect_ratio: "3:4"
  image_size: 2K
- id: night
  type: google-imagen.generate_image
  prompt: "Same poster, but at night with city lights"
  previous_interaction_id: "{{#poster.data.result.id#}}"
- id: combined
  type: google-imagen.edit_image
  prompt: "Put the product from the second image on the table in the first"
  images: ["https://example.com/table.jpg", "https://example.com/product.png"]
```

- Results are `{result, saved_files}`: `result` is the interaction (`id`, `status`, `steps[]` with text and image
  blocks, `usage`), `saved_files` the saved images (`{source, path, bytes, content_type}`). Final images
  (`steps[].content[]`) and the interim "thought images" of thinking models (`steps[].summary[]`) are both saved and
  replaced by their path.
- `edit_image` input images: https URLs (public hosts only, downloaded with size limits, no key sent) or absolute paths
  inside `GOOGLE_IMAGEN_UPLOAD_DIR` (realpath-checked, regular files only); png, jpeg, webp, heic, heif, gif, bmp or
  tiff. Inline data limits the whole request (prompt plus base64 images) to 20 MB
  ([image understanding](https://aistudio.google.com/docs/image-understanding#inline-image)); base64 adds a third, so
  that is about 15 MB of image files in total. Larger requests are refused before anything is sent.
- `edit_image` has 105 s to read its inputs (300 s host timeout minus a 15 s margin and up to 180 s for the
  generation). A slower download is aborted (`timeout`, retryable, nothing sent); if reading still ran past that, the
  generation is not started (`timeout`, not retryable).
- `get_model` accepts the `models/<id>` names that `list_models` returns.
- Interactions are stored by Google by default (needed for `previous_interaction_id` and `get_interaction`).

## Agent policy
All operations except `delete_interaction` (node only) are agent tools. Generation is a paid write, allowed by
default as the catalog policy says, with the prices above; it is never retried automatically. Tool results are
truncated to 20,000 characters; nodes get the full result. `api_request` is GET-only for agents.

## Errors
| Kind | When |
|---|---|
| `auth_error` | `API_KEY_INVALID` / `API_KEY_EXPIRED` (Google answers 400), 401 |
| `permission_denied` | 403 (API not enabled, project restricted), 402 prepaid credits depleted |
| `invalid_input` | 400 bad request or blocked content, inputs refused before sending |
| `not_found` | 404 unknown model or interaction |
| `rate_limited` | 429 rate limit or daily quota |
| `api_error` | 5xx; for generations the error says the outcome is unknown |

Known gap: the Interactions endpoint sometimes wraps errors in an array; their message is shown, but an invalid key
there is reported as `invalid_input` rather than `auth_error`.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Google error mapping and tool truncation;
`test/edit-image.test.mjs` covers the hand-written `edit_image` (base64 blocks, upload allowlist, type checks,
limits, unknown outcome). Live check: `graphrt run google-imagen/example.yaml --plugins .` with an invalid key
returns `auth_error`.

## License
Apache-2.0
