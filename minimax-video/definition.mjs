/**
 * minimax-video plugin definition: MiniMax video generation (https://platform.minimax.io/docs/api-reference/api-overview).
 * The current V2 API (MiniMax-H3 family: text, image and reference to video, up to 2K) with task query, list and
 * cancel/delete, and the V1 Hailuo API (MiniMax-Hailuo-2.3 / 02) with task query and file retrieval.
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * V2 tasks return the video URL in the query response. V1 tasks return a `file_id`; `retrieve_file` turns it into
 * a download URL and saves the file.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

// H3 2K clips of up to 15 s can take several minutes.
const HOST_TIMEOUT_MS = 900000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_DIR_ENV = "MINIMAX_OUTPUT_DIR";
const API_HOSTS = { global: "https://api.minimax.io", china: "https://api.minimaxi.com" };

/**
 * Picks the API host from MINIMAX_REGION.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - When MINIMAX_REGION is not global or china (becomes invalid_input)
 */
function resolveMinimaxBaseUrl(environment) {
  const region = (environment.MINIMAX_REGION ?? "global").trim().toLowerCase() || "global";
  if (!Object.hasOwn(API_HOSTS, region)) throw new Error("MINIMAX_REGION must be global (api.minimax.io) or china (api.minimaxi.com)");
  return API_HOSTS[region];
}

/**
 * A node-only copy of a create operation that also takes `callback_url`. MiniMax POSTs task updates there, so the
 * agent-callable create operations do not accept one.
 *
 * @param operation - Create operation spec (object)
 * @returns Operation spec named `<name>_with_callback` (object)
 */
function withCallback(operation) {
  return {
    ...operation,
    name: `${operation.name}_with_callback`,
    title: `${operation.title} with callback`,
    description: `${operation.description}; MiniMax also POSTs status changes to callback_url (it must echo the challenge first)`,
    nodeOnly: true,
    params: { ...operation.params, callback_url: { in: "body", type: "string", required: true, minLength: 1, description: "URL MiniMax notifies on status changes" } },
  };
}

const CHECK_HINT_V2 = "list_tasks (newest first) for a task with the same prompt";
const CHECK_HINT_V1 = "the task list in the MiniMax console; V1 has no list endpoint";

// --- V2: MiniMax H3 -------------------------------------------------------------------------------------

const generateVideo = {
  name: "generate_video",
  title: "Generate video (H3)",
  description: "Text, image (first/last frame) or reference to video with MiniMax-H3 models (paid per second; waits and saves the video)",
  method: "POST",
  path: "/v2/video_generation",
  write: "unsafe",
  checkHint: CHECK_HINT_V2,
  params: {
    model: { in: "body", type: "string", enum: ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"], default: "MiniMax-H3", description: "H3 variant (2K only on MiniMax-H3)" },
    content: {
      in: "body",
      type: "array",
      required: true,
      maxItems: 20,
      items: { type: "object" },
      description:
        'One text item plus optional media, e.g. [{"type":"text","text":"..."}] or add {"type":"image_url","image_url":{"url":"https://..."},"role":"first_frame"} (roles: first_frame, last_frame, reference_image, reference_video, reference_audio)',
    },
    resolution: { in: "body", type: "string", enum: ["480P", "768P", "2K"], default: "768P", description: "MiniMax-H3: 768P or 2K; other variants: 480P or 768P" },
    duration: { in: "body", type: "integer", min: 4, max: 15, default: 5, description: "Seconds, 4–15 (MiniMax-H3-Max: 5–15)" },
    ratio: { in: "body", type: "string", enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], description: "Required for text to video (not adaptive); image to video always uses the image's ratio" },
    generate_audio: { in: "body", type: "boolean", description: "Include audio (default true)" },
    prompt_expansion_mode: { in: "body", type: "string", enum: ["disabled", "balanced", "quality"], wireName: "extra.prompt_expansion_mode", description: "MiniMax-H3-Max only" },
  },
  job: {
    idPath: "task_id",
    poll: { path: "/v2/query/video_generation/{id}" },
    statusPath: "task.status",
    doneValues: ["succeeded"],
    failedValues: ["failed", "cancelled"],
    errorPath: "task.error.message",
    resultPath: "task.content",
    intervalMs: 10000,
  },
  download: { saveTo: { urlPaths: ["url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 5 } },
};

const getTask = {
  name: "get_task",
  title: "Get task (H3)",
  description: "Status (queued, running, succeeded, failed, cancelled), error, usage and video URL of a V2 task from the last 7 days; saves the video of a succeeded task",
  path: "/v2/query/video_generation/{task_id}",
  params: { task_id: { in: "path", type: "string", required: true, description: "Task id from generate_video" } },
  download: { saveTo: { urlPaths: ["task.content.url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 5 } },
};

const listTasks = {
  name: "list_tasks",
  title: "List tasks (H3)",
  description: "V2 tasks from the last 7 days, newest first, filtered by status, model or task type",
  path: "/v2/query/video_generation",
  params: {
    status: { in: "query", type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"], wireName: "filter.status", description: "Only tasks in this status" },
    model: { in: "query", type: "string", wireName: "filter.model", description: "Only tasks of this model, e.g. MiniMax-H3" },
  },
  response: { dataPath: "items", pagePagination: { pageParam: "page_num", sizeParam: "page_size", firstPage: 1 }, maxLimit: 100 },
};

const deleteTask = {
  name: "delete_task",
  title: "Cancel or delete task (H3)",
  description: "Cancel a queued V2 task, or delete a finished task's record and video",
  method: "DELETE",
  path: "/v2/video_generation/{task_id}",
  write: "unsafe",
  nodeOnly: true,
  params: { task_id: { in: "path", type: "string", required: true, description: "Task id" } },
};

// --- V1: Hailuo -----------------------------------------------------------------------------------------

const generateHailuoVideo = {
  name: "generate_hailuo_video",
  title: "Generate video (Hailuo)",
  description: "Text, image or first+last frame to video with Hailuo 2.3 / 02 (paid per video; waits and returns the file_id for retrieve_file)",
  method: "POST",
  path: "/v1/video_generation",
  write: "unsafe",
  checkHint: CHECK_HINT_V1,
  params: {
    model: { in: "body", type: "string", default: "MiniMax-Hailuo-2.3", description: "MiniMax-Hailuo-2.3, MiniMax-Hailuo-2.3-Fast (image to video), MiniMax-Hailuo-02 (also first+last frame)" },
    prompt: { in: "body", type: "string", description: "What the video shows (up to 2000 characters); camera moves as [Pan left], [Zoom in], ... (required without an image)" },
    first_frame_image: { in: "body", type: "string", description: "First frame: public image URL or data URL (image to video)" },
    last_frame_image: { in: "body", type: "string", description: "Last frame (MiniMax-Hailuo-02)" },
    duration: { in: "body", type: "integer", enum: [6, 10], description: "6 or 10 seconds (10 s only at 768P)" },
    resolution: { in: "body", type: "string", enum: ["512P", "720P", "768P", "1080P"], description: "Default 768P for Hailuo 2.3 / 02" },
    prompt_optimizer: { in: "body", type: "boolean", description: "Let MiniMax rewrite the prompt (default true)" },
    fast_pretreatment: { in: "body", type: "boolean", description: "Shorter prompt optimization" },
  },
  job: {
    idPath: "task_id",
    poll: { path: "/v1/query/video_generation", params: { task_id: "{id}" } },
    statusPath: "status",
    doneValues: ["Success"],
    failedValues: ["Fail"],
    errorPath: "base_resp.status_msg",
    resultPath: "file_id",
    intervalMs: 10000,
  },
};

const getHailuoTask = {
  name: "get_hailuo_task",
  title: "Get task (Hailuo)",
  description: "Status (Preparing, Queueing, Processing, Success, Fail) and file_id of a V1 Hailuo task",
  path: "/v1/query/video_generation",
  params: { task_id: { in: "query", type: "string", required: true, description: "Task id from generate_hailuo_video" } },
};

const retrieveFile = {
  name: "retrieve_file",
  title: "Retrieve file",
  description: "Download URL (valid about 1 hour) and details of a generated file, e.g. a Hailuo video's file_id; saves the file",
  path: "/v1/files/retrieve",
  params: { file_id: { in: "query", type: "string", required: true, description: "File id, e.g. the result of generate_hailuo_video" } },
  download: { saveTo: { urlPaths: ["file.download_url"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 1 } },
};

export const pluginDefinition = defineRestPlugin({
  name: "minimax-video",
  version: "0.1.0",
  description: "MiniMax video: H3 text/image/reference to video (V2) and Hailuo 2.3 (V1) as polled tasks with downloads, task status and file retrieval",
  apiName: "MiniMax API",
  baseUrl: resolveMinimaxBaseUrl,
  extraEnv: ["MINIMAX_REGION"],
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  auth: { type: "bearer", env: "MINIMAX_API_KEY" },
  // V2 answers HTTP errors as {"type":"error","error":{"type","message"}}; V1 answers 200 with
  // {"base_resp":{"status_code","status_msg"}} where status_code 0 is success.
  errors: {
    messagePath: ["error.message", "base_resp.status_msg"],
    codePath: "base_resp.status_code",
    okPath: "base_resp.status_code",
    okValue: 0,
    kindByCode: { 1004: "auth_error", 2049: "auth_error", 1002: "rate_limited", 1039: "rate_limited", 1008: "permission_denied", 1026: "invalid_input", 1027: "invalid_input", 2013: "invalid_input" },
    kindByStatus: { 402: "permission_denied" },
  },
  apiRequest: { examplePath: "/v2/query/video_generation" },
  operations: [generateVideo, withCallback(generateVideo), getTask, listTasks, deleteTask, generateHailuoVideo, withCallback(generateHailuoVideo), getHailuoTask, retrieveFile],
});
