/**
 * kling plugin definition: the official Kling AI API (https://kling.ai/document-api) on its global host
 * api-singapore.klingai.com, in the current API design (model version in the path, tasks queried with GET /tasks).
 * Text to video, image to video and omni (reference) video as polled tasks, task queries and resource packages.
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Auth is the API key from the Kling console as a Bearer token; Kling says it works for all models. The older
 * access key + secret key JWT scheme is only for the legacy API design (`model_name` in the body) and is not used.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

// Kling 4.0 clips of up to 30 s at 1080p can take several minutes, more under load.
const HOST_TIMEOUT_MS = 900000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_DIR_ENV = "KLING_OUTPUT_DIR";

const taskJob = {
  idPath: "data.id",
  poll: { path: "/tasks", params: { task_ids: "{id}" } },
  statusPath: "data.0.status",
  doneValues: ["succeeded"],
  failedValues: ["failed"],
  errorPath: "data.0.message",
  resultPath: "data.0.outputs",
  intervalMs: 10000,
};

const outputDownload = { saveTo: { urlPaths: ["[].url", "[].watermark_url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 10 } };
const CHECK_HINT = "get_tasks with the external_task_id you set, or list_tasks for the newest tasks";

const modelParam = (example) => ({ in: "path", type: "string", required: true, description: `Model in the path, e.g. ${example}` });

// No callback_url here: Kling would POST task results to any host, so only the node-only *_with_callback
// variants (withCallback below) take one.
const optionParams = {
  external_task_id: { in: "body", type: "string", wireName: "options.external_task_id", description: "Your own unique task id; lets you find the task again with get_tasks" },
  watermark: { in: "body", type: "boolean", wireName: "options.watermark_info.enabled", description: "Also produce a watermarked copy" },
};

const settingsParams = {
  resolution: { in: "body", type: "string", enum: ["720p", "1080p", "4k"], wireName: "settings.resolution", description: "Output resolution (4k only on kling-3.0 models; kling-4.0-flash is 720p only)" },
  duration: { in: "body", type: "integer", min: 3, max: 30, wireName: "settings.duration", description: "Seconds (kling-4.0: 3–30, kling-4.0-flash: 3–20, 3.0 models: 3–15, 2.x: 5 or 10)" },
  audio: { in: "body", type: "string", enum: ["native", "off"], wireName: "settings.audio", description: "Native audio for kling-3.0 and kling-2.6 (costs more); Kling 4.0 decides from the prompt" },
};

const aspectRatioParam = {
  in: "body",
  type: "string",
  enum: ["21:9", "16:9", "9:16", "1:1", "4:3", "3:4"],
  wireName: "settings.aspect_ratio",
  description: "Frame aspect ratio (21:9, 4:3 and 3:4 only on Kling 4.0 models)",
};

/**
 * A node-only copy of a create operation that also takes `callback_url` (Kling notifies it on every status change).
 *
 * @param operation - Create operation spec (object)
 * @returns Operation spec named `<name>_with_callback` (object)
 */
function withCallback(operation) {
  return {
    ...operation,
    name: `${operation.name}_with_callback`,
    title: `${operation.title} (callback)`,
    description: `${operation.description}; Kling also notifies callback_url on status changes`,
    nodeOnly: true,
    params: {
      ...operation.params,
      callback_url: { in: "body", type: "string", required: true, minLength: 1, wireName: "options.callback_url", description: "URL Kling notifies when the task status changes" },
    },
  };
}

const contentsParam = (description) => ({ in: "body", type: "array", required: true, maxItems: 20, items: { type: "object" }, description });

const textToVideo = {
  name: "text_to_video",
  title: "Text to video",
  description: "Generate a video from a prompt with a Kling model (paid per second; waits for the task and saves the video)",
  method: "POST",
  path: "/text-to-video/{model}",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    model: modelParam("kling-4.0, kling-4.0-flash, kling-3.0-turbo, kling-3.0, kling-2.6, kling-2.5-turbo"),
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "Scene, characters, actions, camera movement and style" },
    aspect_ratio: aspectRatioParam,
    multi_shot: { in: "body", type: "boolean", wireName: "settings.multi_shot", description: "Multi-shot video (kling-3.0)" },
    ...settingsParams,
    ...optionParams,
  },
  job: taskJob,
  download: outputDownload,
};

const imageToVideo = {
  name: "image_to_video",
  title: "Image to video",
  description: "Animate first/middle/last frame images with a prompt (paid per second; waits and saves the video)",
  method: "POST",
  path: "/image-to-video/{model}",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    model: modelParam("kling-4.0, kling-4.0-flash, kling-3.0-turbo, kling-3.0, kling-2.6, kling-2.5-turbo"),
    contents: contentsParam('Inputs in order, e.g. [{"type":"prompt","text":"..."},{"type":"first_frame","url":"https://..."},{"type":"last_frame","url":"https://..."}] (jpg/png up to 30 MB)'),
    ...settingsParams,
    ...optionParams,
  },
  job: taskJob,
  download: outputDownload,
};

const omniVideo = {
  name: "omni_video",
  title: "Omni video",
  description: "Generate a video from a prompt plus reference images, videos or elements (paid per second; waits and saves the video)",
  method: "POST",
  path: "/omni-video/{model}",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    model: modelParam("kling-4.0, kling-4.0-flash, kling-3.0-omni, kling-o1"),
    contents: contentsParam('Prompt and references, e.g. [{"type":"prompt","text":"..."},{"type":"image","url":"https://..."}]; see the Kling omni docs for reference types'),
    // Omni video also takes "adaptive" (the default: from the prompt, then the references, else 16:9).
    aspect_ratio: { ...aspectRatioParam, enum: [...aspectRatioParam.enum, "adaptive"], description: "Frame aspect ratio, or adaptive (default) to follow the prompt and references" },
    ...settingsParams,
    ...optionParams,
  },
  job: taskJob,
  download: outputDownload,
};

const getTasks = {
  name: "get_tasks",
  title: "Get tasks",
  description: "Status (submitted, processing, succeeded, failed), outputs, usage and billing of tasks by id; saves the outputs of finished ones",
  path: "/tasks",
  params: {
    task_ids: { in: "query", type: "array", items: { type: "string" }, maxItems: 50, description: "Task ids from a generation call" },
    external_task_ids: { in: "query", type: "array", items: { type: "string" }, maxItems: 50, description: "Or your external_task_id values (not both)" },
  },
  response: { dataPath: "data" },
  download: { saveTo: { urlPaths: ["[].outputs[].url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 20 } },
};

const listTasks = {
  name: "list_tasks",
  title: "List tasks",
  description: "Tasks created in a time window (default the last 30 days), optionally filtered by status or product type",
  method: "POST",
  path: "/tasks",
  write: "idempotent",
  params: {
    start_time: { in: "body", type: "string", description: "Unix time in ms (default end_time - 30 days)" },
    end_time: { in: "body", type: "string", description: "Unix time in ms (default now)" },
    filters: { in: "body", type: "array", items: { type: "object" }, maxItems: 5, description: 'e.g. [{"key":"status","values":["succeeded"]},{"key":"product_type","values":["video"]}]' },
  },
  response: { dataPath: "data.result", cursorPath: "data.next_cursor", cursorParam: "cursor", limitParam: "limit", hasMorePath: "data.has_more", maxLimit: 500 },
};

const getAccountCosts = {
  name: "get_account_costs",
  title: "Resource packages",
  description: "Resource packages bought in a time window with their remaining quantity (free to call; at most 1 call per second)",
  path: "/account/costs",
  params: {
    start_time: { in: "query", type: "integer", required: true, min: 0, description: "Unix time in ms" },
    end_time: { in: "query", type: "integer", required: true, min: 0, description: "Unix time in ms" },
    resource_pack_name: { in: "query", type: "string", description: "Only this resource package" },
  },
};

const AUTH_CODES = { 1000: "auth_error", 1001: "auth_error", 1002: "auth_error", 1003: "auth_error", 1004: "auth_error" };
const ACCOUNT_CODES = { 1100: "permission_denied", 1101: "permission_denied", 1102: "permission_denied", 1103: "permission_denied", 1304: "permission_denied" };
const REQUEST_CODES = { 1200: "invalid_input", 1201: "invalid_input", 1202: "not_found", 1203: "not_found", 1300: "invalid_input", 1301: "invalid_input" };
const LIMIT_CODES = { 1302: "rate_limited", 1303: "rate_limited" };

export const pluginDefinition = defineRestPlugin({
  name: "kling",
  version: "0.1.0",
  description: "Kling AI (official API): text, image and omni video with Kling 4.0/3.0/2.x as polled tasks with downloads, task queries and resource packages",
  apiName: "Kling AI API",
  baseUrl: "https://api-singapore.klingai.com",
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  auth: { type: "bearer", env: "KLING_API_KEY" },
  // Every body is {code, message, request_id, data}; code 0 is success.
  errors: {
    messagePath: "message",
    codePath: "code",
    okPath: "code",
    okValue: 0,
    kindByCode: { ...AUTH_CODES, ...ACCOUNT_CODES, ...REQUEST_CODES, ...LIMIT_CODES },
  },
  apiRequest: { examplePath: "/tasks" },
  operations: [textToVideo, imageToVideo, omniVideo, ...[textToVideo, imageToVideo, omniVideo].map(withCallback), getTasks, listTasks, getAccountCosts],
});
