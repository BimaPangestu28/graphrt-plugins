# stability-ai

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the
[Stability AI REST API](https://docs.stability.ai/api-reference) (Stable Image v2beta): generate images with Stable
Image Ultra, Core and Stable Diffusion 3.5, upscale, edit (erase, inpaint, outpaint, search and replace/recolor,
remove background) and control (sketch, structure, style). Results are saved into a local folder. Built with the
[declarative REST layer](../docs/declarative-plugins.md).

> **Warning:** every successful generation, upscale or edit spends credits (1 credit = $0.01, see Pricing).

## Features
- **Generate:** `generate_ultra`, `generate_core`, `generate_sd3` (text-to-image, and image-to-image for Ultra and SD 3.5)
- **Upscale:** `upscale_fast` (4x), `upscale_conservative` (to 4 MP), `upscale_creative` (async job, waits and saves the
  result), `get_result` (fetch any async result by id)
- **Edit:** `erase_object`, `inpaint`, `outpaint`, `search_and_replace`, `search_and_recolor`, `remove_background`
- **Control:** `control_sketch`, `control_structure`, `control_style`
- **Account:** `get_account`, `get_balance` (free)
- **`api_request`:** any other endpoint, e.g. `/v1/engines/list` (GET only when called by an agent)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Stability AI account with credits (25 free credits on sign-up)

## Installation
```bash
graphrt plugin install ./stability-ai
```

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `STABILITY_API_KEY` | yes | API key from <https://platform.stability.ai/dashboard/api-keys> (sent as `Authorization: Bearer`) |
| `STABILITY_AI_OUTPUT_DIR` | for image operations | Absolute directory where images are saved. Synchronous operations refuse to run without it (the API answers with raw image bytes) |
| `STABILITY_AI_UPLOAD_DIR` | for local uploads | Absolute directory that `image`/`mask` inputs may be read from. Unset: only https URLs are accepted |

A node may pass `access_token` to use another key; agent tools never can.

## Pricing
Credits per successful result (failed results are free), from <https://docs.stability.ai/pricing>, November 2026:

| Operation | Credits | | Operation | Credits |
|---|---:|---|---|---:|
| generate_ultra | 8 | | erase_object | 5 |
| generate_sd3 large / large-turbo / medium | 6.5 / 4 / 3.5 | | inpaint | 5 |
| generate_core | 3 | | outpaint | 4 |
| upscale_creative | 60 | | search_and_replace / search_and_recolor | 5 |
| upscale_conservative | 40 | | remove_background | 5 |
| upscale_fast | 2 | | control_sketch / structure / style | 5 |

Account reads and `get_result` are free. Rate limit: 150 requests per 10 seconds (then 60 s blocked).

## Usage
```yaml
- id: draft
  type: stability-ai.generate_core
  prompt: "A cozy cabin in a snowy forest, golden hour"
  aspect_ratio: "16:9"
- id: big
  type: stability-ai.upscale_fast
  image: "{{#draft.data.path#}}"   # needs STABILITY_AI_UPLOAD_DIR to include the output dir
```

- Synchronous operations return `{path, bytes, content_type}` of the saved image.
- `upscale_creative` returns `{job_id, status, result, saved_files}`: `status` is the `finish_reason`, `saved_files`
  holds the image. With `wait: false` it returns the id at once; fetch it later with `get_result` (kept 24 hours).
- `finish_reason` `CONTENT_FILTERED` means the output was blurred by moderation (still charged as a result).
- Upload inputs are an https URL (public hosts only) or an absolute path inside `STABILITY_AI_UPLOAD_DIR` (symlinks
  cannot leave it; max 25 MB).

## Agent policy
All operations are agent tools: generation and editing are paid writes, allowed by default as the catalog policy
says, with the prices above. Failed writes are never retried automatically, and their errors say the outcome is
unknown. `api_request` is GET-only for agents.

## Errors
Errors are `{id, name, errors: [...]}`; the first message and the `name` are shown.

| Kind | When |
|---|---|
| `auth_error` | 401, missing or invalid key |
| `permission_denied` | 402, not enough credits |
| `invalid_input` | 400 bad parameter, 403 flagged by content moderation, 413 body too large, 422 unsupported image or language |
| `rate_limited` | 429 |
| `not_found` | 404, unknown or expired async result |
| `api_error` | 5xx |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus binary saving, the async results flow (202 then 200)
and the 402/403 mapping. Live check: `graphrt run stability-ai/example.yaml --plugins .` with an invalid key returns
`auth_error`.

## License
Apache-2.0
