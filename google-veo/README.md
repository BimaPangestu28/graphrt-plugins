# google-veo

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Google's Veo 3.1 video models on
[Vertex AI](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate) (now called the
Gemini Enterprise Agent Platform). It starts a long-running `predictLongRunning` operation, polls
`fetchPredictOperation` until the video is ready, and saves inline videos to disk.

**Why Vertex AI and not the Gemini API?** The Veo 3.1 *preview* models of the Gemini API
(`veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview` on
`generativelanguage.googleapis.com`) were shut down on 2026-10-22, and Google's
[deprecations page](https://aistudio.google.com/docs/deprecations) lists the older Gemini API Veo models
(`veo-3.0-*-001`, `veo-2.0-generate-001`) as shut down on 2026-06-30. Google points callers to Gemini Omni Flash
(`gemini-omni-1.2-flash`, a different, conversational API) or to the GA Veo models on Vertex AI / the Gemini
Enterprise Agent Platform (`veo-3.1-generate-001`, `veo-3.1-fast-generate-001`), which this plugin uses.

## Features
- **`generate_video`:** text to video, image to video (first frame, optional last frame), and extending a Veo video;
  aspect ratio, 720p/1080p/4K, 4/6/8 s, audio, 1–4 samples, seed, negative prompt; waits and saves the videos
- **`get_operation`:** state of an operation (`done`, `error`, `response.videos`); saves inline videos of a finished
  one, so a later run can collect a video started with `wait: false`
- **`api_request`:** any other Vertex AI call under the project/location (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with billing and the Vertex AI API enabled, and Veo access in `us-central1`

## Installation
```bash
graphrt plugin install ./google-veo
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | yes | Project id (e.g. `my-project`) or project number |
| `GOOGLE_CLOUD_LOCATION` | no | Region, default `us-central1` (the only region Veo 3.1 is listed in) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | yes (or a node `access_token`) | OAuth client and a refresh token with the `https://www.googleapis.com/auth/cloud-platform` scope |
| `GOOGLE_VEO_OUTPUT_DIR` | no | Absolute directory for inline videos. Unset: nothing is saved and the base64 bytes stay in the result (large; use `storage_uri` or set this) |

**Credentials:**
1. In the Google Cloud console enable the **Vertex AI API** for the project, and give your user (or the account the
   refresh token belongs to) the **Vertex AI User** role (`roles/aiplatform.user`).
2. Create an OAuth client (Desktop app) under *APIs & Services → Credentials*.
3. Get a refresh token for the `cloud-platform` scope, e.g. with the
   [OAuth Playground](https://developers.google.com/oauthplayground/) using your own client.

A workflow node can instead pass a short-lived `access_token` (e.g. from `gcloud auth print-access-token`). Service
account key files are not supported by this plugin yet.

**Output location:** with `storage_uri` (`gs://bucket/folder/`) Veo writes the MP4s to Cloud Storage and returns
`gs://` URIs (the account needs write access to the bucket; download them with your Cloud Storage tooling). Without
it, Veo returns the videos inline as base64 and the plugin writes them to `GOOGLE_VEO_OUTPUT_DIR`.

**Inline size limit:** an inline result is one JSON response that the plugin reads into memory (each
`get_operation` read may take up to 5 minutes). So inline mode is limited to **one video of up to 1080p** (an 8 s
1080p clip is typically a few tens of MB as base64); `resolution: 4k` or `sample_count` above 1 are refused before
anything is billed unless `storage_uri` is set. Google documents no exact byte limit for inline results.

## Pricing (billing warning)
Veo is billed per second of generated video, for every sample. From the
[Vertex AI pricing page](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) at the time
of writing:

| Model | Video + audio | Video only |
|---|---|---|
| `veo-3.1-generate-001` | $0.40/s (720p, 1080p), $0.60/s (4K) | $0.20/s, $0.40/s (4K) |
| `veo-3.1-fast-generate-001` | $0.10/s (720p), $0.12/s (1080p), $0.30/s (4K) | $0.08/s, $0.10/s, $0.25/s |
| `veo-3.1-lite-generate-001` (preview) | $0.05/s (720p), $0.08/s (1080p) | $0.03/s, $0.05/s |

So one 8 s `veo-3.1-generate-001` clip with audio costs $3.20, and `sample_count: 4` costs four times that.

## Quick Start
```bash
GOOGLE_CLOUD_PROJECT=my-project GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
  graphrt run google-veo/example.yaml --plugins . -i operation_name=projects/.../operations/...
```
The example reads the state of an operation started earlier (nothing is billed).

## Usage
```yaml
- id: clip
  type: google-veo.generate_video
  prompt: "A lighthouse at dusk, waves crashing, a gull calls"
  aspect_ratio: "16:9"
  resolution: 1080p
  duration_seconds: 8
  storage_uri: "gs://my-bucket/veo/"
```
`data` is `{job_id, model, status, result, saved_files}`: `job_id` is the operation name and `result` is Veo's
response (`videos: [{gcsUri | bytesBase64Encoded, mimeType}]`, `raiMediaFilteredCount`).

### Long jobs and polling across runs
- A call waits up to about 14.5 minutes (manifest timeout 15 minutes), polling every 10 seconds.
- `wait: false` returns `{job_id, model, response}` at once; call `get_operation` later with `model` and
  `operation_name` (= `job_id`).
- A timeout names the operation and is not retried: a retry would generate (and bill) another video.

### Input images and videos
First and last frames are `gs://` URIs (`image_gcs_uri`, `last_frame_gcs_uri`) or inline base64 (`image_base64`),
always with `image_mime_type`. `video_gcs_uri` extends an existing Veo video. Reference images (asset/style) are not
exposed yet; send them from a workflow node with `api_request`.

## Agent policy
- `generate_video` is paid but available to agents as a tool (see Pricing).
- There are no delete or cancel operations.
- `api_request` is GET-only for agents.

## Errors
| Situation | Kind |
|---|---|
| OAuth client or refresh token rejected, expired access token | `auth_error` |
| Vertex AI API disabled, no access to Veo, no quota project | `permission_denied` (403) |
| Invalid parameters (`INVALID_ARGUMENT`, `FAILED_PRECONDITION`) | `invalid_input` |
| Quota exceeded (`RESOURCE_EXHAUSTED`, 429) | `rate_limited` |
| Operation finished with an `error` | `api_error`, names the operation, not retryable |
| All videos blocked by Responsible AI filters | `invalid_input` with Veo's reasons, not retryable |

A create call that fails with a 5xx or network error is never retried and says the outcome is unknown.

## Implementation note
`get_operation` is declarative. `generate_video` is written by hand in
[`lib/generate-video.mjs`](lib/generate-video.mjs): Vertex marks both success and failure as `done: true` (failure
adds `error`), and the request needs `instances` as an array, which the declarative layer cannot express. It keeps
the declarative job rules (one deadline inside the host timeout, non-retryable failures after create naming the
operation, no retry of the create call) and polls through `get_operation`.

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite for `get_operation`; `test/generate-video.test.mjs`
covers the body mapping, polling, failures, Responsible AI blocks, timeouts and saved videos.

## License
Apache-2.0
