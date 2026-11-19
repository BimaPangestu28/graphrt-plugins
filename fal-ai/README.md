# fal-ai

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [fal.ai](https://fal.ai): run any fal model
(FLUX, Recraft, Kling, Veo, Whisper, ...) through the [Queue API](https://fal.ai/docs/model-apis/model-endpoints/queue),
wait for the result and save the media files, check, fetch or cancel queued requests, and search models and their
prices with the [Platform API](https://fal.ai/docs/platform-apis/v1/models). Built with the
[declarative REST layer](../docs/declarative-plugins.md).

> **Warning:** every `run_model` call is billed to your fal account (see Pricing).

## Features
- **`run_model`:** submit to `queue.fal.run/<model_id>` (sub-paths such as `fal-ai/flux-pro/v1.1-ultra` work), poll
  `status_url` until `COMPLETED`, fetch `response_url`, and download the media URLs. `wait: false` returns the
  `request_id` and URLs at once.
- **`get_request_status`, `get_request_result`, `cancel_request`:** follow up on a request by `owner`, `app` and
  `request_id` (the model id without its sub-path: `fal-ai` + `flux` for `fal-ai/flux/dev`).
- **`search_models`:** free-text, category or endpoint-id lookup, optionally with each model's OpenAPI input schema.
- **`get_pricing`, `estimate_cost`:** unit prices and cost estimates for your account (free).

Full operation reference: [OPERATIONS.md](OPERATIONS.md). There is no `api_request`: the queue API has nothing to
read besides the operations above.

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A fal account with credits

## Installation
```bash
graphrt plugin install ./fal-ai
```

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `FAL_KEY` | yes | API key from <https://fal.ai/dashboard/keys> with the `API` preset (sent as `Authorization: Key <key>`) |
| `FAL_AI_OUTPUT_DIR` | for files | Absolute directory where result media are saved. Unset: nothing is downloaded and the result keeps fal's URLs, which expire |
| `FAL_AI_EXTRA_DOWNLOAD_HOSTS` | no | Comma-separated extra hosts media may be downloaded from (exact host names), for models that return files outside fal's CDN |

A node may pass `access_token` to use another key; agent tools never can.

## Pricing
fal bills each model per output: per image or megapixel (FLUX.1 [dev] is priced per megapixel), per second of
video, per audio minute, or per GPU second for some models. Prices differ by model and account; check them with
`get_pricing` / `estimate_cost` or <https://fal.ai/pricing> before running. Requests that fail are generally not
billed; a request that times out on our side keeps running, so cancel it with `cancel_request` if you no longer need it.

## Usage
```yaml
- id: image
  type: fal-ai.run_model
  model_id: fal-ai/flux/schnell
  input: { prompt: "a watercolor fox in the snow", image_size: landscape_4_3, num_images: 1 }
- id: answer
  type: answer
  answer: "Saved {{#image.data.saved_files.0.path#}}"
```

- `run_model` returns `{job_id, status, result, saved_files}`: `result` is the model's output, `saved_files` the
  downloads from `images[].url`, `image.url`, `video.url`, `videos[].url`, `audio.url`, `audio_file.url`,
  `audio_url.url`, `model_mesh.url`, `file.url` and `files[].url` (other shapes keep their URLs in `result`).
- Media are downloaded only from fal's CDN, `*.fal.media` (e.g. `v3.fal.media`, see the
  [storage API](https://fal.ai/docs/platform-apis/v1/storage/files/sign)), plus `FAL_AI_EXTRA_DOWNLOAD_HOSTS`. A URL
  on another host is listed in `saved_files` with an error and is not fetched. Files with a restricted ACL need a
  signed URL and are not handled.
- A request that fails is reported by fal as `COMPLETED` with `error` and `error_type`; `run_model` turns that into an
  `api_error` with fal's message and the request id (not retryable) instead of fetching a result.
- Up to 300 s is waited. After that (or any failure after the submit) the error names the `request_id` and the
  status/result URLs; follow up with `get_request_status` and `get_request_result` instead of running it again.
- Status and result URLs must be on `queue.fal.run` (the key is only sent there); media downloads are public https
  without the key.

## Agent policy
All operations are agent tools. Running a model is a paid write, allowed by default as the catalog policy says, with
the pricing above; it is never retried automatically. `cancel_request` is a tool too (it only stops work).
Webhooks are not offered.

## Errors
| Kind | When |
|---|---|
| `auth_error` | 401, missing or invalid key (`authorization_error`) |
| `permission_denied` | 403, key preset without access, or account locked for billing |
| `invalid_input` | 400 / 422, inputs that do not match the model schema (the first validation message is shown) |
| `not_found` | 404, unknown model, or a request that does not exist, expired or belongs to another account |
| `rate_limited` | 429 |
| `api_error` | 5xx; a request that COMPLETED with `error` (fal's message and `error_type`, the request id, not retryable) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus the queue flow (Key auth, status_url,
response_url, media download), errors on the result, refused status hosts and the Platform error mapping;
`test/run-model.test.mjs` covers COMPLETED-with-error failures, delivery-host limits, `wait: false` and timeouts.
Live check: `graphrt run fal-ai/example.yaml --plugins .` with an invalid key returns `auth_error`.

## License
Apache-2.0
