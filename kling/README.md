# kling

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the official [Kling AI API](https://kling.ai/document-api)
(global host `https://api-singapore.klingai.com`). It generates videos with Kling 4.0, 4.0 Flash, 3.0, 3.0 Turbo,
O1 and 2.x models from text, images or references, waits for each task, and saves the result to disk. It can also
query tasks (to poll across workflow runs) and read your resource packages.

It uses Kling's current API design: the model is part of the path (`/text-to-video/kling-4.0`) and every task is
queried with `GET /tasks`. Built with the declarative REST layer: the plugin is the data in
[`definition.mjs`](definition.mjs).

## Features
- **`text_to_video`:** prompt to video; resolution, aspect ratio, duration (Kling 4.0 up to 30 s), native audio
  and multi-shot where the model supports them
- **`image_to_video`:** first, middle and last frame images (`contents`) to video
- **`omni_video`:** prompt plus reference images, videos or elements (aspect ratio may be `adaptive`)
- **`text_to_video_with_callback`, `image_to_video_with_callback`, `omni_video_with_callback`** (node only): the
  same, plus a `callback_url` that Kling notifies on every status change
- **`get_tasks`:** status, outputs, usage and billing of up to 50 tasks by id (or by your `external_task_id`);
  saves the outputs of finished tasks
- **`list_tasks`:** tasks in a time window with status / product type filters (cursor pagination)
- **`get_account_costs`:** resource packages and their remaining quantity
- **`api_request`:** any other endpoint (GET only for agents), e.g. image generation via a workflow node

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Kling AI API account (developer console) with a resource package or balance

## Installation
```bash
graphrt plugin install ./kling
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `KLING_API_KEY` | yes | API key from the Kling AI developer console |
| `KLING_OUTPUT_DIR` | no | Absolute directory for generated files. Unset: nothing is saved and `saved_files` is `[]` (Kling keeps results for 30 days) |

**Getting a key:** open the [Kling AI developer console](https://app.klingai.com/global/dev), click
**+ Create a new API Key**, and copy the key (it is shown once). It is sent as `Authorization: Bearer <key>`.

**Auth note:** Kling documents the API key for all models. The older Access Key + Secret Key scheme (a self-signed
HS256 JWT with `iss` = access key, 30-minute expiry) only applies to the legacy API design with `model_name` in the
body, which this plugin does not use. The old host `api.klingai.com` was replaced by `api-singapore.klingai.com` for
callers outside China. No third-party gateway is involved.

## Pricing (billing warning)
Every generation is billed per second of output video from your resource packages (units) or balance. From
[Kling's pricing page](https://kling.ai/document-api/pricing/base/video) at the time of writing:

| Model | 720p | 1080p |
|---|---:|---:|
| Kling 4.0 (no input video) | 1.0 unit ($0.157)/s | 1.5 units ($0.235)/s |
| Kling 4.0 Flash (no input video) | 0.6 units/s | — |
| Kling 3.0 Turbo (native audio) | 0.8 units ($0.112)/s | 1.0 unit ($0.14)/s |
| Kling 3.0 (no audio / audio) | 0.6 / 0.9 units/s | 0.8 / 1.2 units/s (4K 3.0 units/s) |
| Kling 2.6 / 2.5 Turbo (no audio) | 0.3 units ($0.042)/s | 0.5 units ($0.07)/s |

With input videos, Kling 4.0 bills input plus output duration (at least twice the output). Kling 4.0 without a
`duration` uses the length in the prompt, else 10 s; the billed length is `usage.output_duration` in `get_tasks`.
So a 10 s Kling 4.0 1080p video costs about $2.35.

## Quick Start
```bash
KLING_API_KEY=... graphrt run kling/example.yaml --plugins .
```
The example lists your resource packages (free to call).

## Usage
```yaml
- id: clip
  type: kling.text_to_video
  model: kling-4.0
  prompt: "A man in a white shirt walks along a beach at sunset, cinematic, the camera follows from behind"
  duration: 10
  resolution: 1080p
  aspect_ratio: "16:9"
  external_task_id: "{{#start.order_id#}}"
```
`data` is `{job_id, status, result, saved_files}`: `result` is the task's `outputs` (`[{type, id, url, duration}]`).

### Long jobs and polling across runs
- A call waits up to about 14.5 minutes (manifest timeout 15 minutes), polling every 10 seconds.
- `wait: false` returns `{job_id, response}` at once; call `get_tasks` with the id later. It saves the outputs of
  succeeded tasks into `$KLING_OUTPUT_DIR`.
- Set `external_task_id` (unique per account): if a create call fails with an unknown outcome, look the task up
  with `get_tasks` `external_task_ids` before retrying. Timeouts and failures after create are never retried.

## Agent policy
- Generation operations are paid but available to agents as tools (see Pricing).
- Callbacks are node only (`*_with_callback`): Kling would send task results to any URL, so the tool operations do
  not accept `callback_url`. Kling has no delete or cancel endpoint for video tasks.
- `api_request` is GET-only for agents.

## Errors
Kling answers `{code, message, request_id}`; code 0 is success (a non-zero code in a 200 is an error too).

| Codes | Kind |
|---|---|
| 1000–1004 (bad, empty, not yet valid or expired authorization) | `auth_error` |
| 1100–1103, 1304 (account issue, arrears, packages used up, no access to the model, IP allowlist) | `permission_denied` |
| 1200, 1201, 1300, 1301 (bad parameters, content policy) | `invalid_input` |
| 1202, 1203 (unknown method or resource) | `not_found` |
| 1302, 1303 (rate or concurrency limit) | `rate_limited` |
| 5000–5002 | `api_error` (reads retried) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus polling, failure and service-code cases.

## License
Apache-2.0
