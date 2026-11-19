# luma-ai

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Luma AI video and image generation through the
[Luma Agents API](https://docs.agents.lumalabs.ai/api/) (`https://agents.lumalabs.ai/v1`), Luma's current API. It
generates Ray 3.2 videos from text or images, edits and reframes existing videos, generates uni-1 images, waits for
each job and saves the result to disk.

**Why not the Dream Machine API?** Luma's older Dream Machine API (`api.lumalabs.ai/dream-machine/v1`, `ray-2`,
camera "concepts") now sends callers to the Agents API as the latest Luma API, and Ray 3.2 is only served there.
Camera moves are written in the prompt ("slow dolly in", "orbit left").

Built with the declarative REST layer: the plugin is the data in [`definition.mjs`](definition.mjs).

## Features
- **`generate_video`:** text to video, image to video (`start_frame_url`, `end_frame_url`) and extending a video
  (`extend_generation_id`); 360p–1080p, 5 s or 10 s, loop and HDR
- **`edit_video`:** re-render a Luma generation or a video URL (up to 18 s) under a new prompt with a
  strength preset (`adhere_*`, `flex_*`, `reimagine_*`)
- **`reframe_video`:** change a video's aspect ratio, generating the new areas
- **`generate_image`:** uni-1 / uni-1-max 2K images with up to 9 reference images
- **`get_generation`:** state, `failure_code`, `usage.credits_charged` and fresh output URLs; saves a completed
  generation's output
- **`delete_generation`** (node only) and **`get_deletion`**: asynchronous deletion of finished generations
- **`get_credits`, `get_usage`:** balance and settled spend (summary or grouped by model, user, session, ...)
- **`api_request`:** any other endpoint (GET only for agents), e.g. `/files`

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Luma API Platform account with credits

## Installation
```bash
graphrt plugin install ./luma-ai
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `LUMA_API_KEY` | yes | API key from the [Luma API Platform](https://platform.lumalabs.ai/) |
| `LUMA_OUTPUT_DIR` | no | Absolute directory for generated files. Unset: nothing is saved and `saved_files` is `[]` (output URLs expire after 1 hour) |

**Getting a key:** sign in at [platform.lumalabs.ai](https://platform.lumalabs.ai/), add credits (Pay-as-you-go or a
plan) and create an API key. Keys from the old Dream Machine dashboard are for the old API.

## Pricing (billing warning)
Every generation spends credits. The dollar value of a credit depends on your plan or contract (`get_usage` returns
`overage_rate` when one applies). From Luma's [pricing page](https://docs.agents.lumalabs.ai/guides/pricing/) at the
time of writing, Ray 3.2 `generate_video` (standard dynamic range):

| Resolution | 5 s | 10 s |
|---|---:|---:|
| 360p (draft) | 20 credits | 60 credits |
| 540p | 50 | 150 |
| 720p | 100 | 300 |
| 1080p | 400 | 1200 |

HDR (720p/1080p, 5 s) costs 200/800 credits, extend 50–400 per extend, reframe 10–120 credits per second, and
edits have their own, higher table. Images: uni-1 14 credits, uni-1-max 34 credits (+1 per reference image).
A finished generation reports what it cost in `usage.credits_charged` (via `get_generation`).

## Quick Start
```bash
LUMA_API_KEY=... graphrt run luma-ai/example.yaml --plugins .
```
The example reads the credit balance (no credits spent).

## Usage
```yaml
- id: clip
  type: luma-ai.generate_video
  prompt: "A slow dolly shot through a misty greenhouse at sunrise"
  aspect_ratio: "16:9"
  resolution: 720p
  duration: 5s
```
`data` is `{job_id, status, result, saved_files}`: `result` is Luma's `output` list (`[{type, url}]`).

### Long jobs and polling across runs
- A call waits up to about 14.5 minutes (manifest timeout 15 minutes), polling every 5 seconds.
- `wait: false` returns `{job_id, response}` at once; call `get_generation` later. It saves the output of a
  completed generation into `$LUMA_OUTPUT_DIR` and always returns fresh presigned URLs.
- A timeout names the generation id and is not retried: a retry would start and pay for a second generation.

### Edit and reframe sources
Give exactly one source: `source_generation_id` (a completed Luma video), or `source_url` with
`source_media_type` (e.g. `video/mp4`). Advanced controls (keyframes, per-signal controls, `file_id` uploads) can
be sent from a workflow node with `api_request`.

## Agent policy
- Generation operations are paid but available to agents as tools (see Pricing).
- `delete_generation` is node only.
- `api_request` is GET-only for agents.

## Errors
| Situation | Kind |
|---|---|
| Missing or invalid key | `auth_error` (401) |
| Insufficient balance | `permission_denied` (402) |
| Disabled model, suspended client | `permission_denied` (403) |
| Bad parameters or rejected input (`USER.ARTIFACT.MODERATED`) | `invalid_input` (400/413/422) |
| Rate limit or concurrency limit | `rate_limited` (429, `Retry-After` honoured) |
| Generation `failed` | `api_error` with `failure_reason`, not retryable |

Luma's 500 `INTERNAL.SYSTEM.DATABASE_ERROR` means the generation may still run: the plugin never retries a create
call after a 5xx, and the error says to check before retrying.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus Luma-specific error and job cases.

## License
Apache-2.0
