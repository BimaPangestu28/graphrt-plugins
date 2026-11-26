# replicate

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Replicate HTTP API](https://replicate.com/docs/reference/http):
run any model (official models, specific versions or your deployments) as a prediction, wait for it, and download
the output files; browse and search models, versions and collections. Built with the
[declarative REST layer](../docs/declarative-plugins.md).

> **Warning:** every prediction is billed to your Replicate account (by output or by hardware time, see Pricing).

## Features
- **Run:** `run_model` (official models, no version, e.g. `black-forest-labs/flux-schnell`), `create_prediction`
  (any model version), `run_deployment` (your deployments). They wait for the prediction (polling `urls.get`) and
  save output URLs into a folder. `wait: false` returns the prediction at once.
- **Predictions:** `get_prediction`, `list_predictions`, `cancel_prediction`
- **Models:** `search` (beta), `list_models`, `get_model` (with the latest version's input schema),
  `list_model_versions`, `get_model_version`, `list_collections`, `get_collection`, `list_hardware`
- **Account:** `get_account`
- **`api_request`:** any other endpoint, e.g. `/v1/files` (GET only when called by an agent)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Replicate account with billing set up

## Installation
```bash
graphrt plugin install ./replicate
```

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `REPLICATE_API_TOKEN` | yes | API token from <https://replicate.com/account/api-tokens> (sent as `Authorization: Bearer`) |
| `REPLICATE_OUTPUT_DIR` | for files | Absolute directory where output files are saved. Unset: nothing is downloaded and `output` keeps the URLs (they expire after about an hour) |
| `REPLICATE_EXTRA_DOWNLOAD_HOSTS` | no | Comma-separated extra hosts output files may be downloaded from (exact host names), for models that return files elsewhere |

A node may pass `access_token` to use another token; agent tools never can.

## Pricing
Each model has its own price on its page (`https://replicate.com/<owner>/<name>`): official models usually bill per
output (for example per image or per second of video), other models by the second of hardware time (CPU from about
$0.0001/s, GPUs up to several dollars an hour). Deployments also bill while instances are idle. A prediction that
times out on our side keeps running and billing; set `cancel_after` (for example `5m`) to cap it, or call
`cancel_prediction`. Reads are free (limits: 600 prediction creates and 3000 other requests a minute).

## Usage
```yaml
- id: image
  type: replicate.run_model
  model_owner: black-forest-labs
  model_name: flux-schnell
  input: { prompt: "a watercolor fox in the snow", num_outputs: 1, output_format: png }
  cancel_after: 2m
- id: answer
  type: answer
  answer: "Saved {{#image.data.saved_files.0.path#}}"
```

- Run operations return `{job_id, status, result, saved_files}`: `result` is the model's `output` (a URL, a list of
  URLs, text or an object), `saved_files` the downloaded files (`{url, path, bytes, content_type}`, or `{url, error}`).
  Only outputs that are a URL or a list of URLs are downloaded; text outputs (for example the token list of a language
  model) are left in `result` and nothing is fetched for them.
- Downloads are limited to `replicate.delivery` and its subdomains, where Replicate serves output files
  ([output files](https://replicate.com/docs/topics/predictions/output-files)), plus `REPLICATE_EXTRA_DOWNLOAD_HOSTS`.
  A URL on another host is listed in `saved_files` with an error and is not fetched.
- Output URLs need no `Authorization` header: Replicate's output-files guide tells clients to remove any
  Authorization header logic for them, and they expire after one hour. The plugin never sends the API token to
  download hosts (on purpose); if a model returns a file that needs the token (for example a Files API URL on
  `api.replicate.com`), fetch it with `api_request` instead.
- Up to 300 s is waited for a prediction. After that the error names the prediction id and `urls.get`; check it with
  `get_prediction` instead of running it again.
- Status and cancel URLs must be on `api.replicate.com` (the token is only ever sent there); downloads are public https
  without the token.

## Agent policy
All operations are agent tools. Running a model is a paid write, allowed by default as the catalog policy says, with
the pricing above; it is never retried automatically (a retry would start and bill a second prediction).
`cancel_prediction` is a tool too (it only stops billing). Webhooks and deployment management are not offered.
`api_request` is GET-only for agents.

## Errors
Errors are problem details (`{"title", "detail", "status"}`); `detail` is shown.

| Kind | When |
|---|---|
| `auth_error` | 401, missing or invalid token |
| `permission_denied` | 402 insufficient credit / billing required, 403 |
| `not_found` | 404, unknown model, version or prediction |
| `invalid_input` | 400 / 422, input that does not match the model schema |
| `rate_limited` | 429 |
| `api_error` | 5xx; a prediction that `failed` or was `canceled` (with the model's error and the prediction id) |

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus urls.get polling, single and list output downloads,
failed predictions, refused status hosts and the error mapping. Live check: `graphrt run replicate/example.yaml
--plugins .` with an invalid token returns `auth_error`.

## License
Apache-2.0
