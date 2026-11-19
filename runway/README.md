# runway

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Runway API](https://docs.dev.runwayml.com/api/).
It generates videos and images as Runway tasks, waits for them, and saves the results to disk. It can also read a
task's status (to poll across workflow runs), cancel or delete a task, and read the organization's credits.

Built with the declarative REST layer: the plugin is the data in [`definition.mjs`](definition.mjs).

## Features
- **`image_to_video`, `text_to_video`:** any Runway video model (`gen4.5`, `gen4_turbo`, `veo3.1`, `veo3.1_fast`,
  Kling, Seedance, Hailuo, ... models served by Runway), with ratio, duration, seed, audio and negative prompt
- **`video_to_video`:** edit or restyle a video of up to 30 s (`aleph2` by default) with optional keyframes
- **`video_upscale`:** Magnific upscaling to 720p–4K, or frame rate conversion (`enhance_frame_rate`)
- **`text_to_image`:** `gen4_image` / `gen4_image_turbo` and other image models, with up to 3 reference images
- **`get_task`:** status of any task; for a finished task it saves the output too
- **`cancel_task`** (node only): cancel a running task or delete a finished one
- **`get_organization`, `query_usage`:** credit balance, tier limits and credits used per model per day
- **`api_request`:** any other endpoint (GET only for agents), e.g. `/v1/avatars`

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Runway developer account with prepaid credits

## Installation
```bash
graphrt plugin install ./runway
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `RUNWAY_API_KEY` | yes | API key (starts with `key_`) |
| `RUNWAY_OUTPUT_DIR` | no | Absolute directory for generated files. Unset: nothing is saved and `saved_files` is `[]`; the output URLs are still returned |

**Getting a key:** sign in at [dev.runwayml.com](https://dev.runwayml.com/), create an organization, buy credits and
create an API key. The key is shown once. Every request sends `X-Runway-Version: 2024-11-06`, the API version this
plugin was built against.

## Pricing (billing warning)
Every generation call spends credits; one credit costs $0.01 (prepaid). From Runway's
[pricing page](https://docs.dev.runwayml.com/guides/pricing/) at the time of writing:

| Model | Price |
|---|---|
| `gen4.5` | 12 credits/s ($0.12/s) |
| `gen4_turbo` | 5 credits/s ($0.05/s) |
| `veo3.1` | 40 credits/s with audio, 20 without |
| `veo3.1_fast` | 15 credits/s with audio, 10 without |
| `aleph2` (video to video) | 28 credits/s, 56 minimum |
| `gen4_image` / `gen4_image_turbo` | 5–8 / 2 credits per image |
| `magnific_video_upscaler_creative` | 0.7–1.2 credits per output frame |

So a 10 s `gen4.5` video costs about $1.20. Each create response holds `estimatedCost.credits`, and a finished
task holds `cost.credits`. Check `get_organization` before large batches.

## Quick Start
```bash
RUNWAY_API_KEY=key_... graphrt run runway/example.yaml --plugins .
```
The example reads the credit balance (no credits spent).

## Usage
```yaml
- id: clip
  type: runway.image_to_video
  prompt_image: "https://example.com/product.png"
  prompt_text: "Slow orbit around the product, studio light"
  ratio: "1280:720"
  duration: 5
```
`data` is `{job_id, status, result, saved_files}`: `result` is Runway's `output` (an array of URLs that expire in
24–48 hours) and `saved_files` lists the files saved into `$RUNWAY_OUTPUT_DIR`.

### Long jobs and polling across runs
- A call waits up to about 14.5 minutes (the manifest timeout is 15 minutes) and polls every 5 seconds. Most
  tasks finish in 1–5 minutes.
- With `wait: false` it returns `{job_id, response}` at once; a later run calls `get_task` with that id. When the
  task has `SUCCEEDED`, `get_task` saves the output into `$RUNWAY_OUTPUT_DIR` as well.
- If waiting times out, the error names the task id and says the task is still running: do not start a new one,
  call `get_task` later. A retry would start (and pay for) a second task, so these errors are never retried.

### Inputs
Images and videos are https URLs, `runway://` URIs from Runway's upload endpoint, or `data:` URIs (up to 5 MB).
Allowed `ratio` and `duration` values differ per model; Runway answers an unsupported combination with a 400
whose message names the field. `ratio` is required by `gen4.5`, `gen4_turbo` and `veo3.1` (and most image models)
and must be left out for models that do not accept it, such as `h3_max`. For `video_to_video`, `aleph2`,
`gemini_omni_flash*` and `kling_4*` take `video_uri`, while `seedance2*`, `hailuo3*` and `klingO3*` take
`prompt_video`. `prompt_image` takes a single first frame; for first/last-frame arrays use
`api_request` from a workflow node.

## Agent policy
- Generation operations are paid but available to agents as tools (see Pricing).
- `cancel_task` is node only, because it also deletes finished tasks and their output.
- `api_request` is GET-only for agents.

## Errors
| Situation | Kind |
|---|---|
| Missing, invalid or revoked key | `auth_error` (401) |
| Invalid parameters for the model | `invalid_input` (400, with Runway's message) |
| Too many concurrent tasks / throttled | `rate_limited` (429) |
| Task `FAILED` or `CANCELLED` | `api_error` with Runway's `failure`, not retryable |
| Still running when the call's time ran out | `timeout`, names the task id, not retryable |

A create call that fails with a 5xx or a network error is not retried (the task may exist); check the task list in
the Runway dashboard first.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Runway-specific cases (version header, `wait: false`,
failure reasons, node-only cancel).

## License
Apache-2.0
