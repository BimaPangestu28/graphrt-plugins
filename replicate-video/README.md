# replicate-video

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for running video models on
[Replicate](https://replicate.com/docs/reference/http) (Veo, Kling, Hailuo, Wan, Seedance, LTX and many more).
It creates predictions, waits for them with long-job time limits, and saves the output files to disk. It can also
read a prediction's status (to poll across workflow runs) and find models and their input schemas.

It is its own plugin, tuned for video: a 15-minute time limit, 5 s polling and downloads up to 1 GB per file. Built
with the declarative REST layer: the plugin is the data in [`definition.mjs`](definition.mjs).

## Features
- **`run_model`:** run an official or latest-version model by `owner/name` (e.g. `google/veo-3`,
  `kwaivgi/kling-v2.1`, `minimax/hailuo-02`) with its `input` object
- **`run_version`:** run a pinned model version
- **`run_model_with_webhook`, `run_version_with_webhook`** (node only): the same, plus a `webhook` URL that
  Replicate POSTs the prediction to on every update
- **`get_prediction`:** status, logs, metrics and output; saves the output of a succeeded prediction
- **`cancel_prediction`** (node only)
- **`list_predictions`:** your predictions, newest first (paginated)
- **`get_model`, `list_model_versions`:** description, default example and the input/output schema
  (`latest_version.openapi_schema`)
- **`get_collection`, `search_models`:** discover models, e.g. the `text-to-video` and `image-to-video` collections
- **`get_account`**, and **`api_request`** for any other endpoint (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Replicate account with billing set up

## Installation
```bash
graphrt plugin install ./replicate-video
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `REPLICATE_API_TOKEN` | yes | API token (starts with `r8_`) |
| `REPLICATE_OUTPUT_DIR` | no | Absolute directory for output files. Unset: nothing is saved and `saved_files` is `[]`; the output URLs are still returned |

**Getting a token:** sign in at [replicate.com](https://replicate.com/), add a payment method, and create a token at
[replicate.com/account/api-tokens](https://replicate.com/account/api-tokens).

## Pricing (billing warning)
Every prediction is billed to your account. Prices are set per model and shown on each model's page:
- Official video models are usually billed per second of output video (or per output). For example,
  `wavespeedai/wan-2.1-i2v-480p` is $0.09 and `wan-2.1-i2v-720p` $0.25 per second of video; premium models such as
  Veo cost several times more.
- Community models are billed per second of hardware time, e.g. $0.001400/s on an A100 (80GB) and $0.001525/s on
  an H100.

See [replicate.com/pricing](https://replicate.com/pricing) and the model page before running in a loop. A canceled
prediction is billed for the time it ran. Use `cancel_after` (e.g. `"20m"`) to stop runaway predictions.

## Quick Start
```bash
REPLICATE_API_TOKEN=r8_... graphrt run replicate-video/example.yaml --plugins .
```
The example lists the text-to-video collection (no prediction is run).

## Usage
```yaml
- id: clip
  type: replicate-video.run_model
  model_owner: minimax
  model_name: hailuo-02
  input:
    prompt: "A paper boat drifting across a calm pond at dawn"
    duration: 6
```
`data` is `{job_id, status, result, saved_files}`: `result` is the prediction's `output` (a URL or a list of
URLs, which Replicate deletes after about an hour for API predictions), `saved_files` lists the saved files.

### Long jobs and polling across runs
- A call waits up to about 14.5 minutes (manifest timeout 15 minutes), polling every 5 seconds.
- `wait: false` returns `{job_id, response}` at once; call `get_prediction` later, which also saves the output
  once the prediction has succeeded.
- A timeout names the prediction id and is not retried (a retry would pay for a second prediction).

### Inputs
`input` is passed through as is; file inputs are https URLs (or data URIs for small files). Use `get_model` to read
the model's input schema (`latest_version.openapi_schema.components.schemas.Input`).

## Agent policy
- `run_model` and `run_version` are paid but available to agents as tools (see Pricing).
- `cancel_prediction` is node only, so an agent cannot stop other runs.
- Webhooks are node only (`*_with_webhook`): a webhook sends the prediction, with its input and output URLs, to any
  host, so `run_model` and `run_version` do not accept one.
- `api_request` is GET-only for agents.
- Output files are downloaded with the public-https checks (https only, public hosts on every redirect, size cap)
  and never receive the API token.

## Errors
| Situation | Kind |
|---|---|
| Missing or invalid token | `auth_error` (401) |
| Model or prediction not found | `not_found` (404) |
| Invalid input for the model | `invalid_input` (422, with Replicate's `detail`) |
| Rate limited | `rate_limited` (429) |
| Prediction `failed`, `canceled` or `aborted` | `api_error` with the prediction's `error`, not retryable |

A create call that fails with a 5xx or network error is not retried; check `list_predictions` first.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus multi-file downloads and failure cases.

## License
Apache-2.0
