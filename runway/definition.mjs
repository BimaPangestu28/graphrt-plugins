/**
 * runway plugin definition: Runway API (https://docs.dev.runwayml.com/api/) video and image generation as
 * long-running tasks: image to video, text to video, video to video, video upscale and text to image, plus task
 * status, cancel/delete and organization credits. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Every generation is a task: the create call returns `{id}`, the plugin polls GET /v1/tasks/{id} until
 * SUCCEEDED (or FAILED/CANCELLED) and saves the output URLs into $RUNWAY_OUTPUT_DIR. `wait: false` returns the
 * task id at once so a later run can call `get_task`.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

// Generation tasks usually finish in 1–5 minutes; 4K and long clips can take longer.
const HOST_TIMEOUT_MS = 900000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const RUNWAY_API_VERSION = "2024-11-06";

const OUTPUT_DIR_ENV = "RUNWAY_OUTPUT_DIR";

const taskJob = {
  idPath: "id",
  poll: { path: "/v1/tasks/{id}" },
  statusPath: "status",
  doneValues: ["SUCCEEDED"],
  failedValues: ["FAILED", "CANCELLED"],
  errorPath: "failure",
  resultPath: "output",
  intervalMs: 5000,
};

// `output` is an array of URLs (valid 24–48 hours).
const taskDownload = { saveTo: { urlPaths: ["[]"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_VIDEO_BYTES, maxFiles: 10 } };

const sharedParams = {
  seed: { in: "body", type: "integer", min: 0, max: 4294967295, description: "Random seed for reproducible results" },
  public_figure_threshold: {
    in: "body",
    type: "string",
    enum: ["auto", "low"],
    wireName: "contentModeration.publicFigureThreshold",
    description: "low makes moderation less strict about recognizable public figures",
  },
};

const videoParams = {
  // Runway's spec requires ratio for gen4.5, gen4_turbo, veo3.1(_fast) and, for text to video, kling3.0/klingO3;
  // other models make it optional and some (h3_max, happyhorse_1_0, grok_imagine_1_5, kling2.5_turbo_pro) lack it.
  ratio: { in: "body", type: "string", description: "Output resolution as W:H, e.g. 1280:720 or 720:1280. Required by gen4.5, gen4_turbo and veo3.1; omit it for models that do not take it (e.g. h3_max)" },
  duration: { in: "body", type: "integer", min: 1, max: 30, description: "Seconds of video (gen4.5: 2–10, required; veo3.1: 4, 6 or 8; kling models up to 15)" },
  audio: { in: "body", type: "boolean", description: "Generate audio (veo3.1, kling, seedance, hailuo models; affects price)" },
  negative_prompt: { in: "body", type: "string", minLength: 1, wireName: "negativePrompt", description: "What should not appear (veo3.1 models)" },
  output_format: { in: "body", type: "string", wireName: "outputFormat", description: "Container/encoding: mp4 (default), prores, png_sequence, ... (gen4.5)" },
  ...sharedParams,
};

const MODEL_NOTE = "Runway model id, e.g. gen4.5 (12 credits/s), gen4_turbo (5 credits/s, image only), veo3.1, veo3.1_fast, kling3.0_pro, seedance2, hailuo3";

const imageToVideo = {
  name: "image_to_video",
  title: "Image to video",
  description: "Animate an image into a video with a Runway model (paid; waits for the task and saves the video)",
  method: "POST",
  path: "/v1/image_to_video",
  write: "unsafe",
  checkHint: "the Runway dashboard task list, or get_task with the id from an earlier wait:false call",
  params: {
    model: { in: "body", type: "string", default: "gen4.5", description: MODEL_NOTE },
    prompt_image: { in: "body", type: "string", required: true, minLength: 1, wireName: "promptImage", description: "First frame: an https URL, a runway:// upload URI or a data: URI (up to 5 MB)" },
    prompt_text: { in: "body", type: "string", minLength: 1, wireName: "promptText", description: "What should happen in the video (required by gen4.5)" },
    ...videoParams,
  },
  job: taskJob,
  download: taskDownload,
};

const textToVideo = {
  name: "text_to_video",
  title: "Text to video",
  description: "Generate a video from a text prompt with a Runway model (paid; waits for the task and saves the video)",
  method: "POST",
  path: "/v1/text_to_video",
  write: "unsafe",
  checkHint: "the Runway dashboard task list, or get_task with the id from an earlier wait:false call",
  params: {
    model: { in: "body", type: "string", default: "gen4.5", description: MODEL_NOTE },
    prompt_text: { in: "body", type: "string", required: true, minLength: 1, wireName: "promptText", description: "What should appear in the video" },
    ...videoParams,
  },
  job: taskJob,
  download: taskDownload,
};

const videoToVideo = {
  name: "video_to_video",
  title: "Video to video",
  description: "Edit or restyle an input video (up to 30 s) with a prompt, e.g. with aleph2 (paid; waits and saves the video); give video_uri or prompt_video as the model expects",
  method: "POST",
  path: "/v1/video_to_video",
  write: "unsafe",
  checkHint: "the Runway dashboard task list, or get_task with the id from an earlier wait:false call",
  params: {
    model: { in: "body", type: "string", default: "aleph2", description: "Runway model id, e.g. aleph2 (28 credits/s, 56 minimum)" },
    video_uri: { in: "body", type: "string", minLength: 1, wireName: "videoUri", description: "Input video for aleph2, gemini_omni_flash* and kling_4*: an https URL, a runway:// upload URI or a data: URI" },
    prompt_video: { in: "body", type: "string", minLength: 1, wireName: "promptVideo", description: "Input video for seedance2*, hailuo3* and klingO3* models (instead of video_uri)" },
    prompt_text: { in: "body", type: "string", minLength: 1, wireName: "promptText", description: "What the edited video should show" },
    ratio: { in: "body", type: "string", description: "Output resolution as W:H, e.g. 1280:720" },
    keyframes: { in: "body", type: "array", maxItems: 5, items: { type: "object" }, description: "Guidance images: [{uri, seconds} or {uri, at}] (aleph2)" },
    ...sharedParams,
  },
  job: taskJob,
  download: taskDownload,
};

const videoUpscale = {
  name: "video_upscale",
  title: "Upscale video",
  description: "Upscale a video (up to 30 s) to 720p–4K, or raise its frame rate (paid; waits and saves the video)",
  method: "POST",
  path: "/v1/video_upscale",
  write: "unsafe",
  checkHint: "the Runway dashboard task list, or get_task with the id from an earlier wait:false call",
  params: {
    model: { in: "body", type: "string", default: "magnific_video_upscaler_creative", description: "magnific_video_upscaler_creative or enhance_frame_rate" },
    video_uri: { in: "body", type: "string", required: true, minLength: 1, wireName: "videoUri", description: "Video to upscale: an https URL, a runway:// upload URI or a data: URI" },
    resolution: { in: "body", type: "string", enum: ["720p", "1k", "2k", "4k"], description: "Target resolution (default 2k; magnific_video_upscaler_creative)" },
    creativity: { in: "body", type: "integer", min: 0, max: 100, description: "AI detail added, 0 (faithful) to 100" },
    target_framerate: { in: "body", type: "string", wireName: "targetFramerate", description: "Output frame rate for enhance_frame_rate, e.g. 30, 60, 29_97" },
  },
  job: taskJob,
  download: taskDownload,
};

const textToImage = {
  name: "text_to_image",
  title: "Text to image",
  description: "Generate an image from a prompt and optional reference images (paid; waits and saves the image)",
  method: "POST",
  path: "/v1/text_to_image",
  write: "unsafe",
  checkHint: "the Runway dashboard task list, or get_task with the id from an earlier wait:false call",
  params: {
    model: { in: "body", type: "string", default: "gen4_image", description: "Runway image model, e.g. gen4_image (5–8 credits), gen4_image_turbo (2 credits, needs reference_images)" },
    prompt_text: { in: "body", type: "string", required: true, minLength: 1, wireName: "promptText", description: "What the image should show; reference tags as @tag" },
    ratio: { in: "body", type: "string", description: "Output resolution as W:H, e.g. 1920:1080 or 1024:1024 (required by most image models; optional for ideogram and vector models)" },
    reference_images: { in: "body", type: "array", maxItems: 3, items: { type: "object" }, wireName: "referenceImages", description: "Up to 3 references: [{uri, tag?}]" },
    ...sharedParams,
  },
  job: taskJob,
  download: taskDownload,
};

const getTask = {
  name: "get_task",
  title: "Get task",
  description: "Status of a Runway task (PENDING, THROTTLED, RUNNING, SUCCEEDED, FAILED, CANCELLED); saves the output of a finished task",
  path: "/v1/tasks/{task_id}",
  params: { task_id: { in: "path", type: "string", required: true, description: "Task id from a generation call" } },
  download: { saveTo: { urlPaths: ["output"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_VIDEO_BYTES, maxFiles: 10 } },
};

const cancelTask = {
  name: "cancel_task",
  title: "Cancel or delete task",
  description: "Cancel a running task, or delete a finished one and its output",
  method: "DELETE",
  path: "/v1/tasks/{task_id}",
  write: "unsafe",
  nodeOnly: true,
  params: { task_id: { in: "path", type: "string", required: true, description: "Task id" } },
};

const getOrganization = {
  name: "get_organization",
  title: "Organization",
  description: "Credit balance, tier limits and per-model usage of the API key's organization",
  path: "/v1/organization",
};

const queryUsage = {
  name: "query_usage",
  title: "Credit usage",
  description: "Credits used per model per day (UTC) between start_date and before_date",
  method: "POST",
  path: "/v1/organization/usage",
  write: "idempotent",
  params: {
    start_date: { in: "body", type: "string", wireName: "startDate", description: "YYYY-MM-DD, default 30 days ago" },
    before_date: { in: "body", type: "string", wireName: "beforeDate", description: "YYYY-MM-DD, exclusive" },
  },
};

export const pluginDefinition = defineRestPlugin({
  name: "runway",
  version: "0.1.0",
  description: "Runway API: image/text/video to video, video upscale and text to image as polled tasks (paid per credit), task status and credits",
  apiName: "Runway API",
  baseUrl: "https://api.dev.runwayml.com",
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  auth: { type: "bearer", env: "RUNWAY_API_KEY" },
  defaultHeaders: { "x-runway-version": RUNWAY_API_VERSION },
  // Errors are {"error": "...", "issues"?: [...]}; 401 for a bad key, 429 when throttled.
  errors: { messagePath: ["error", "message"] },
  apiRequest: { examplePath: "/v1/organization" },
  operations: [imageToVideo, textToVideo, videoToVideo, videoUpscale, textToImage, getTask, cancelTask, getOrganization, queryUsage],
});
