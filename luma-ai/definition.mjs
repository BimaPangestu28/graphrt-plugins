/**
 * luma-ai plugin definition: Luma's current API, the Luma Agents API (https://docs.agents.lumalabs.ai/api/), for
 * Ray 3.2 video generation, video editing and reframing, uni-1 images, generation status, deletion and credits.
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Luma's older Dream Machine API (api.lumalabs.ai/dream-machine/v1, ray-2, camera "concepts") now points callers to
 * this API as the latest one, so the plugin targets https://agents.lumalabs.ai/v1.
 *
 * Every generation is a job: POST /generations returns `{id, state}`, the plugin polls GET /generations/{id} until
 * `completed` (or `failed`) and saves the presigned output URLs (valid 1 hour) into $LUMA_OUTPUT_DIR.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

// 5 s / 720p usually finishes well under two minutes; 10 s / 1080p HDR can take several.
const HOST_TIMEOUT_MS = 900000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_DIR_ENV = "LUMA_OUTPUT_DIR";

const generationJob = {
  idPath: "id",
  poll: { path: "/generations/{id}" },
  statusPath: "state",
  doneValues: ["completed"],
  failedValues: ["failed"],
  errorPath: "failure_reason",
  resultPath: "output",
  intervalMs: 5000,
};

const outputDownload = { saveTo: { urlPaths: ["[].url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 20 } };
const CHECK_HINT = "the generations in the Luma API Platform dashboard, or get_generation with an id from an earlier wait:false call";

const ASPECT_RATIOS = ["3:1", "2:1", "21:9", "16:9", "4:3", "3:2", "1:1", "4:5", "3:4", "2:3", "9:16", "1:2", "1:3"];

const commonParams = {
  aspect_ratio: { in: "body", type: "string", enum: ASPECT_RATIOS, description: "Output aspect ratio (video: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 ...)" },
  user_id: { in: "body", type: "string", description: "Your end user's stable opaque id (no personal data), for abuse attribution and usage breakdowns" },
};

const videoOutputParams = {
  model: { in: "body", type: "string", default: "ray-3.2", description: "Video model (ray-3.2)" },
  resolution: { in: "body", type: "string", enum: ["360p", "540p", "720p", "1080p"], wireName: "video.resolution", description: "360p is a cheap draft tier" },
  hdr: { in: "body", type: "boolean", wireName: "video.hdr", description: "HDR video (720p/1080p, 5 s only; doubles the price)" },
};

const generateVideo = {
  name: "generate_video",
  title: "Generate video",
  description: "Text to video or image to video with Ray 3.2 (paid; waits for the generation and saves the MP4)",
  method: "POST",
  path: "/generations",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "What the video should show: scene, action, camera" },
    ...videoOutputParams,
    duration: { in: "body", type: "string", enum: ["5s", "10s"], wireName: "video.duration", description: "Clip length (default 5s)" },
    loop: { in: "body", type: "boolean", wireName: "video.loop", description: "Seamless loop (not with 10s, hdr or an end frame)" },
    start_frame_url: { in: "body", type: "string", wireName: "video.start_frame.url", description: "Public image URL for the first frame (image to video)" },
    end_frame_url: { in: "body", type: "string", wireName: "video.end_frame.url", description: "Public image URL for the last frame" },
    extend_generation_id: { in: "body", type: "string", wireName: "video.start_frame.generation_id", description: "Extend this completed video generation (single-keyframe extend)" },
    ...commonParams,
  },
  constants: { body: { type: "video" } },
  job: generationJob,
  download: outputDownload,
};

const editVideo = {
  name: "edit_video",
  title: "Edit video",
  description: "Restyle or edit an existing video (up to 18 s) under a new prompt with Ray 3.2 (paid; waits and saves the MP4)",
  method: "POST",
  path: "/generations",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "How the edited video should look" },
    source_generation_id: { in: "body", type: "string", wireName: "source.generation_id", description: "A completed Luma video generation to edit" },
    source_url: { in: "body", type: "string", wireName: "source.url", description: "Or a public video URL (set source_media_type too)" },
    source_media_type: { in: "body", type: "string", wireName: "source.media_type", description: "MIME type of source_url, e.g. video/mp4" },
    strength: {
      in: "body",
      type: "string",
      enum: ["adhere_1", "adhere_2", "adhere_3", "flex_1", "flex_2", "flex_3", "reimagine_1", "reimagine_2", "reimagine_3"],
      wireName: "video.edit.strength",
      description: "How much the edit preserves (adhere) or reimagines the source",
    },
    auto_controls: { in: "body", type: "boolean", wireName: "video.edit.auto_controls", description: "Let the model derive the conditioning from the source (recommended)" },
    ...videoOutputParams,
    user_id: commonParams.user_id,
  },
  constants: { body: { type: "video_edit" } },
  job: generationJob,
  download: outputDownload,
};

const reframeVideo = {
  name: "reframe_video",
  title: "Reframe video",
  description: "Reframe an existing video to another aspect ratio, generating the new areas (paid per second; waits and saves the MP4)",
  method: "POST",
  path: "/generations",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    aspect_ratio: { ...commonParams.aspect_ratio, required: true, description: "Target aspect ratio, e.g. 9:16" },
    prompt: { in: "body", type: "string", description: "Optional guidance for the generated areas" },
    source_generation_id: { in: "body", type: "string", wireName: "source.generation_id", description: "A completed Luma video generation to reframe" },
    source_url: { in: "body", type: "string", wireName: "source.url", description: "Or a public video URL (set source_media_type too)" },
    source_media_type: { in: "body", type: "string", wireName: "source.media_type", description: "MIME type of source_url, e.g. video/mp4" },
    // Luma's reframing guide sends "model": "ray-3.2" with type video_reframe (the API's default model is uni-1).
    model: videoOutputParams.model,
    resolution: videoOutputParams.resolution,
    user_id: commonParams.user_id,
  },
  constants: { body: { type: "video_reframe" } },
  job: generationJob,
  download: outputDownload,
};

const generateImage = {
  name: "generate_image",
  title: "Generate image",
  description: "Generate a 2K image with uni-1 or uni-1-max, optionally from reference images (paid; waits and saves the image)",
  method: "POST",
  path: "/generations",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "What the image should show" },
    model: { in: "body", type: "string", enum: ["uni-1", "uni-1-max"], default: "uni-1", description: "uni-1 (14 credits) or uni-1-max (34 credits)" },
    image_ref: { in: "body", type: "array", maxItems: 9, items: { type: "object" }, description: "Up to 9 references: [{url} or {generation_id} or {data, media_type}]" },
    output_format: { in: "body", type: "string", enum: ["png", "jpeg"], description: "Image format" },
    ...commonParams,
  },
  constants: { body: { type: "image" } },
  job: generationJob,
  download: outputDownload,
};

const getGeneration = {
  name: "get_generation",
  title: "Get generation",
  description: "State of a generation (queued, processing, completed, failed) with failure_code, usage and fresh output URLs; saves the output of a completed one",
  path: "/generations/{generation_id}",
  params: { generation_id: { in: "path", type: "string", required: true, description: "Generation id" } },
  download: { saveTo: { urlPaths: ["output[].url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 20 } },
};

const deleteGeneration = {
  name: "delete_generation",
  title: "Delete generation",
  description: "Request deletion of a finished generation and its outputs; returns a deletion task to poll with get_deletion",
  method: "DELETE",
  path: "/generations/{generation_id}",
  write: "unsafe",
  nodeOnly: true,
  params: { generation_id: { in: "path", type: "string", required: true, description: "Generation id" } },
};

const getDeletion = {
  name: "get_deletion",
  title: "Get deletion",
  description: "State of a deletion task (completed means the content was removed)",
  path: "/deletions/{task_id}",
  params: { task_id: { in: "path", type: "string", required: true, description: "Deletion task id from delete_generation" } },
};

const getCredits = {
  name: "get_credits",
  title: "Credit balance",
  description: "The team's credit balance (less credits held for running generations)",
  path: "/credits",
};

const getUsage = {
  name: "get_usage",
  title: "Usage",
  description: "Settled credit spend for the billing period or a window of up to 92 days, optionally grouped",
  path: "/usage",
  params: {
    group_by: { in: "query", type: "string", enum: ["model", "user", "session", "api_key", "tenant_id", "metadata"], description: "Omit for the summary" },
    start: { in: "query", type: "string", description: "ISO-8601 start (inclusive); required with end" },
    end: { in: "query", type: "string", description: "ISO-8601 end (exclusive), default now" },
  },
};

export const pluginDefinition = defineRestPlugin({
  name: "luma-ai",
  version: "0.1.0",
  description: "Luma AI (Agents API): Ray 3.2 text/image to video, video edit and reframe, uni-1 images as polled jobs with downloads, credits and usage",
  apiName: "Luma Agents API",
  baseUrl: "https://agents.lumalabs.ai/v1",
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  auth: { type: "bearer", env: "LUMA_API_KEY" },
  // Errors carry `detail` (a string, or {code, message}) and sometimes `error: {code, retry}`.
  errors: {
    messagePath: ["detail.message", "detail", "error.message"],
    codePath: "error.code",
    kindByCode: { "USER.ARTIFACT.MODERATED": "invalid_input", "USER.INPUT.INVALID_PROMPT": "invalid_input" },
    kindByStatus: { 402: "permission_denied", 413: "invalid_input" },
  },
  apiRequest: { examplePath: "/credits" },
  operations: [generateVideo, editVideo, reframeVideo, generateImage, getGeneration, deleteGeneration, getDeletion, getCredits, getUsage],
});
