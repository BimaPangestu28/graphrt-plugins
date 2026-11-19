# minimax-video

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [MiniMax](https://platform.minimax.io/docs/api-reference/api-overview)
video generation. It covers both MiniMax video APIs:

- **V2, MiniMax H3** (`MiniMax-H3`, `-Highspeed`, `-Lite`, `-Max`): text, image (first/last frame) and reference
  to video up to 2K, with audio. The task query returns the video URL.
- **V1, Hailuo** (`MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-2.3-Fast`, `MiniMax-Hailuo-02`): the classic flow of
  create task → query task → retrieve file.

Each generation call waits for the task and saves the video to disk (V2), or returns the `file_id` for
`retrieve_file` (V1). Built with the declarative REST layer: the plugin is the data in
[`definition.mjs`](definition.mjs).

## Features
- **`generate_video`** (H3): `content` items of type `text`, `image_url`, `video_url`, `audio_url` with roles;
  resolution, duration 4–15 s, ratio, audio on/off
- **`get_task`, `list_tasks`** (H3): status, error, usage and video URL; tasks of the last 7 days (paginated)
- **`delete_task`** (H3, node only): cancels a queued task or deletes a finished one
- **`generate_hailuo_video`**: text, image or first+last frame to video with Hailuo; returns the `file_id`
- **`get_hailuo_task`**: status and `file_id` of a V1 task
- **`generate_video_with_callback`, `generate_hailuo_video_with_callback`** (node only): the same, plus a
  `callback_url` that MiniMax POSTs status changes to (it must echo MiniMax's `challenge` first)
- **`retrieve_file`**: download URL of a file (valid about an hour) and saves the file
- **`api_request`:** any other endpoint (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A MiniMax API Platform account with balance

## Installation
```bash
graphrt plugin install ./minimax-video
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `MINIMAX_API_KEY` | yes | API secret key |
| `MINIMAX_REGION` | no | `global` (default, `api.minimax.io`) or `china` (`api.minimaxi.com`, keys from the China platform) |
| `MINIMAX_OUTPUT_DIR` | no | Absolute directory for videos. Unset: nothing is saved and `saved_files` is `[]` |

**Getting a key:** sign in at [platform.minimax.io](https://platform.minimax.io/), add balance, and create an API key
under *API Keys*. China accounts use [platform.minimaxi.com](https://platform.minimaxi.com/) and `MINIMAX_REGION=china`.

## Pricing (billing warning)
Every generation is billed to your balance. From MiniMax's [pricing page](https://platform.minimax.io/docs/pricing/overview)
at the time of writing:

| Model | Output video |
|---|---|
| MiniMax-H3 | $0.13/s at 2K, $0.08/s at 768P |
| MiniMax-H3-Highspeed | $0.06/s at 768P, $0.04/s at 480P |
| MiniMax-H3-Lite | $0.04/s at 768P, $0.025/s at 480P |
| MiniMax-Hailuo-2.3 / 02 | $0.28 per 768P 6 s video, $0.56 per 768P 10 s, $0.49 per 1080P 6 s |
| MiniMax-Hailuo-2.3-Fast | $0.19 per 768P 6 s, $0.32 per 768P 10 s, $0.33 per 1080P 6 s |

H3 input videos are billed per second like output, and images beyond the free allowance per image. So a 10 s
MiniMax-H3 2K video costs about $1.30.

## Quick Start
```bash
MINIMAX_API_KEY=... graphrt run minimax-video/example.yaml --plugins .
```
The example lists recent H3 tasks (nothing is billed).

## Usage
```yaml
- id: clip
  type: minimax-video.generate_video
  content:
    - { type: text, text: "A small paper boat drifts across a calm pond" }
  resolution: 768P
  duration: 6
  ratio: "16:9"
```
`data` is `{job_id, status, result, saved_files}`: `result` is the task's `content` (`{url}`).

Hailuo (V1) is two steps:
```yaml
- { id: clip, type: minimax-video.generate_hailuo_video, prompt: "A cat runs [Tracking shot]", duration: 6 }
- { id: file, type: minimax-video.retrieve_file, file_id: "{{#clip.data.result#}}" }
```

### Long jobs and polling across runs
- A call waits up to about 14.5 minutes (manifest timeout 15 minutes), polling every 10 seconds.
- `wait: false` returns `{job_id, response}` at once; later call `get_task` (H3, also saves the video) or
  `get_hailuo_task` + `retrieve_file` (Hailuo).
- Timeouts and failures after create name the task id and are never retried (a retry pays for a second video).

## Agent policy
- Generation operations are paid but available to agents as tools (see Pricing).
- `delete_task` is node only.
- Callbacks are node only (`*_with_callback`): MiniMax would push task results to any URL, so the tool operations
  do not accept `callback_url`.
- `api_request` is GET-only for agents.

## Errors
| Situation | Kind |
|---|---|
| Missing or invalid key (1004, 2049) | `auth_error` |
| Insufficient balance (1008, HTTP 402) | `permission_denied` |
| Sensitive input or output (1026, 1027), invalid parameters (2013, 400, 422) | `invalid_input` |
| Rate limits (1002, 1039, 429) | `rate_limited` |
| Task `failed` / `Fail` | `api_error` with MiniMax's message, not retryable |

V1 reports errors in a 200 response (`base_resp.status_code` other than 0); the plugin treats those as errors too.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus H3 and Hailuo job flows, error mapping and region
selection.

## License
Apache-2.0
