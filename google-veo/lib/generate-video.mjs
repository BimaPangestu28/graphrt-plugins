/**
 * `generate_video` for google-veo: a hand-written operation next to the declarative ones.
 *
 * Why it is not declarative: Vertex AI's long-running operation reports both success and failure with
 * `done: true` (failure adds `error`, a Responsible AI block leaves `videos` empty), and the declarative job layer
 * can only tell them apart by one status value. The request body also needs `instances` as an array, which
 * dotted wire names cannot build. So this operation builds the body, sends predictLongRunning, and polls through
 * the declarative `get_operation` (which also saves inline videos), with the same safety rules as declarative
 * jobs: one deadline inside the host timeout, failures after create name the operation and are not retryable,
 * and the create call is never retried after an unknown outcome.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { pollUntilDone, resolvePollInterval } from "./shared/polling.mjs";
import { describeJobError, resolveJobBudgetMs } from "./shared/rest-job.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

export const DEFAULT_VEO_MODEL = "veo-3.1-generate-001";
const DEFAULT_POLL_INTERVAL_MS = 10000;
const CHECK_HINT = "Veo has no operation list; look for new files under storage_uri (or in billing) before retrying";

// Friendly parameter name -> Vertex `parameters` field.
const PARAMETER_FIELDS = {
  aspect_ratio: "aspectRatio",
  duration_seconds: "durationSeconds",
  resolution: "resolution",
  generate_audio: "generateAudio",
  sample_count: "sampleCount",
  seed: "seed",
  negative_prompt: "negativePrompt",
  person_generation: "personGeneration",
  enhance_prompt: "enhancePrompt",
  compression_quality: "compressionQuality",
  resize_mode: "resizeMode",
  storage_uri: "storageUri",
};

/** JSON schema of generate_video's arguments. */
export const GENERATE_VIDEO_PARAMETERS = {
  type: "object",
  required: ["prompt"],
  properties: {
    model: { type: "string", default: DEFAULT_VEO_MODEL, description: "veo-3.1-generate-001, veo-3.1-fast-generate-001 or veo-3.1-lite-generate-001 (preview)" },
    prompt: { type: "string", minLength: 1, description: "What the video shows; dialogue in quotes, sounds described in words" },
    negative_prompt: { type: "string", description: "What the video must not show" },
    aspect_ratio: { type: "string", enum: ["16:9", "9:16"], description: "Default 16:9" },
    resolution: { type: "string", enum: ["720p", "1080p", "4k"], description: "Default 720p (4k only on veo-3.1-generate-001)" },
    duration_seconds: { type: "integer", enum: [4, 6, 8], description: "Default 8" },
    generate_audio: { type: "boolean", description: "Generate audio (default true; costs more)" },
    sample_count: { type: "integer", minimum: 1, maximum: 4, description: "Videos to generate (1–4), each billed" },
    seed: { type: "integer", minimum: 0, maximum: 4294967295, description: "Seed for repeatable results" },
    // Values from Google's Veo guides; the generic REST type lists dont_allow/allowAll, which the Veo pages do not.
    person_generation: { type: "string", enum: ["allow_adult", "disallow"], description: "allow_adult (default) or disallow (no people or faces)" },
    enhance_prompt: { type: "boolean", description: "Let Veo rewrite the prompt (default true)" },
    compression_quality: { type: "string", enum: ["optimized", "lossless"], description: "Default optimized" },
    resize_mode: { type: "string", enum: ["pad", "crop"], description: "How an input image is fitted (default pad)" },
    storage_uri: { type: "string", description: "gs://bucket/folder for the output (required for 4k or sample_count > 1); without it one video comes back inline (base64) and is saved to GOOGLE_VEO_OUTPUT_DIR" },
    image_gcs_uri: { type: "string", description: "First frame in Cloud Storage, gs://... (image to video)" },
    image_base64: { type: "string", description: "Or the first frame as base64 bytes" },
    image_mime_type: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"], description: "MIME type of the first and last frame images" },
    last_frame_gcs_uri: { type: "string", description: "Last frame in Cloud Storage, gs://..." },
    video_gcs_uri: { type: "string", description: "A Veo video (gs://..., mp4) to extend" },
    wait: { type: "boolean", default: true, description: "Wait for the video (default true); false returns the operation name at once for get_operation" },
  },
};

/**
 * Builds the predictLongRunning body from generate_video's arguments.
 *
 * @param args - Validated generate_video arguments (object)
 * @returns `{instances: [instance], parameters}` (object)
 * @throws PluginError kind `invalid_input` - Two first-frame sources, an image without a MIME type, a storage_uri that is
 *   not gs://, or 4k / several samples without storage_uri
 *
 * @example
 * buildPredictRequestBody({ prompt: "A boat", aspect_ratio: "9:16" });
 * // { instances: [{ prompt: "A boat" }], parameters: { aspectRatio: "9:16" } }
 */
export function buildPredictRequestBody(args) {
  return { instances: [buildInstance(args)], parameters: buildParameters(args) };
}

function buildInstance(args) {
  const instance = { prompt: args.prompt };
  const firstFrame = describeFirstFrame(args);
  if (firstFrame) instance.image = firstFrame;
  if (args.last_frame_gcs_uri) instance.lastFrame = { gcsUri: args.last_frame_gcs_uri, mimeType: requireImageMimeType(args) };
  if (args.video_gcs_uri) instance.video = { gcsUri: args.video_gcs_uri, mimeType: "video/mp4" };
  return instance;
}

function describeFirstFrame(args) {
  if (args.image_gcs_uri && args.image_base64) throw invalidInput("give the first frame as image_gcs_uri or image_base64, not both");
  if (args.image_gcs_uri) return { gcsUri: args.image_gcs_uri, mimeType: requireImageMimeType(args) };
  if (args.image_base64) return { bytesBase64Encoded: args.image_base64, mimeType: requireImageMimeType(args) };
  return undefined;
}

function requireImageMimeType(args) {
  if (!args.image_mime_type) throw invalidInput("image_mime_type is required with an input image (image/png, image/jpeg or image/webp)");
  return args.image_mime_type;
}

// Inline (base64) results come back in one JSON response that the plugin holds in memory, so only one video of
// up to 1080p (a few tens of MB) may be returned that way; 4K or several samples must go to Cloud Storage.
function assertInlineResultFits(args) {
  if (args.storage_uri !== undefined) return;
  if (args.resolution === "4k") throw invalidInput("4k videos are too large to return inline: set storage_uri (gs://bucket/folder/)");
  if ((args.sample_count ?? 1) > 1) throw invalidInput("more than one sample is too large to return inline: set storage_uri (gs://bucket/folder/)");
}

function buildParameters(args) {
  if (args.storage_uri !== undefined && !String(args.storage_uri).startsWith("gs://")) throw invalidInput("storage_uri must be a Cloud Storage URI starting with gs://");
  assertInlineResultFits(args);
  const entries = Object.entries(PARAMETER_FIELDS).filter(([argumentName]) => args[argumentName] !== undefined);
  return Object.fromEntries(entries.map(([argumentName, fieldName]) => [fieldName, args[argumentName]]));
}

function invalidInput(problem) {
  return new PluginError(`generate_video: ${problem}`, { kind: "invalid_input" });
}

/**
 * Creates the generate_video operation.
 *
 * @param settings - `{getOperation, jobBudgetCapMs}`: the declarative get_operation operation and the host's job budget (object)
 * @returns Operation `{name, title, description, parameters, run}` (object)
 */
export function createGenerateVideoOperation({ getOperation, jobBudgetCapMs }) {
  return {
    name: "generate_video",
    title: "Generate video",
    description: "Generate a Veo 3.1 video from text, a first/last frame or a video to extend (paid per second; waits for the operation and saves inline videos)",
    nodeOnly: false,
    parameters: GENERATE_VIDEO_PARAMETERS,
    run: async (context) => {
      const data = await generateVideo(context, { getOperation, jobBudgetCapMs });
      return { data: context.source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data, next_cursor: null };
    },
  };
}

async function generateVideo(context, settings) {
  const startedAt = Date.now();
  const model = context.args.model ?? DEFAULT_VEO_MODEL;
  const createBody = await startOperation(context, model);
  const operationName = createBody?.name;
  if (typeof operationName !== "string" || operationName === "") {
    throw new PluginError("Vertex AI accepted the request but returned no operation name; a video may be generating, check before retrying", { kind: "api_error", retryable: false });
  }
  if (context.args.wait === false) return { job_id: operationName, model, response: createBody };
  const deadlineAt = startedAt + resolveJobBudgetMs({}, context.environment, settings.jobBudgetCapMs);
  try {
    return await waitForOperation(context, { ...settings, model, operationName, deadlineAt });
  } catch (operationError) {
    throw describeJobError(operationError, operationName, { status: `get_operation ${operationName}` });
  }
}

async function startOperation(context, model) {
  const body = buildPredictRequestBody(context.args);
  try {
    return await context.client.request({
      method: "POST",
      path: `/publishers/google/models/${pathSegment(model)}:predictLongRunning`,
      json: body,
      signal: context.signal,
      redactResponse: true,
    });
  } catch (createError) {
    if (!(createError instanceof PluginError) || !createError.message.includes("outcome unknown")) throw createError;
    throw new PluginError(`${createError.message}. To check: ${CHECK_HINT}`, { kind: createError.kind, retryable: false });
  }
}

async function waitForOperation(context, { getOperation, model, operationName, deadlineAt }) {
  const readStatus = async () => (await getOperation.run({ ...context, args: { model, operation_name: operationName }, source: "node" })).data;
  const finished = await pollUntilDone({
    readStatus,
    isDone: (statusData) => statusData.result?.done === true && !statusData.result.error,
    isFailed: (statusData) => describeOperationError(statusData.result),
    intervalMs: resolvePollInterval(context.environment, DEFAULT_POLL_INTERVAL_MS),
    timeoutMs: Math.max(1, deadlineAt - Date.now()),
    signal: context.signal,
  });
  const response = finished.result.response ?? {};
  assertVideosReturned(response);
  return { job_id: operationName, model, status: "done", result: response, saved_files: finished.saved_files };
}

function describeOperationError(operation) {
  if (operation?.done !== true || !operation.error) return false;
  const { code, message } = operation.error;
  return `${message ?? "the operation failed"}${code === undefined ? "" : ` (code ${code})`}`;
}

function assertVideosReturned(response) {
  if (Array.isArray(response.videos) && response.videos.length > 0) return;
  const reasons = Array.isArray(response.raiMediaFilteredReasons) ? response.raiMediaFilteredReasons.join("; ") : "";
  const filteredNote = response.raiMediaFilteredCount ? `${response.raiMediaFilteredCount} video(s) were blocked by Responsible AI filters` : "no videos were returned";
  throw new PluginError(`Veo finished but ${filteredNote}${reasons ? `: ${reasons}` : ""}; change the prompt or inputs`, { kind: "invalid_input", retryable: false });
}
