/**
 * fal-ai plugin definition: the fal Queue API (https://fal.ai/docs/model-apis/model-endpoints/queue) and the fal
 * Platform API for model search and pricing (https://fal.ai/docs/platform-apis/v1/models), built with the
 * declarative REST layer (docs/declarative-plugins.md).
 *
 * `run_model` submits to https://queue.fal.run/{model_id}, polls the returned `status_url` until COMPLETED, then
 * fetches `response_url`. Media URLs in the result (images[].url, image.url, video.url, audio.url, ...) are saved
 * into $FAL_AI_OUTPUT_DIR because fal's media links expire. Every run is billed to the fal account.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { describeTimeBudgets } from "./lib/shared/rest-spec-helpers.mjs";
import { parseHostList, withRestrictedDownloads } from "./lib/restricted-downloads.mjs";
import { createRunModelOperation } from "./lib/run-model.mjs";

const OUTPUT_DIR_ENV = "FAL_AI_OUTPUT_DIR";
const EXTRA_HOSTS_ENV = "FAL_AI_EXTRA_DOWNLOAD_HOSTS";
// fal CDN files are served from *.fal.media (e.g. https://v3.fal.media/files/b/<id>/<filename>, per the storage
// API docs: https://fal.ai/docs/platform-apis/v1/storage/files/sign).
const DELIVERY_HOST_SUFFIXES = ["fal.media"];
const LIMITS = { timeout_ms: 360000 };
const PLATFORM_URL = "https://api.fal.ai";
const REQUEST_PATH = "/{owner}/{app}/requests/{request_id}";
const MEDIA_URL_PATHS = ["images[].url", "image.url", "video.url", "videos[].url", "audio.url", "audio_file.url", "audio_url.url", "model_mesh.url", "file.url", "files[].url"];

const saveMedia = { saveTo: { urlPaths: MEDIA_URL_PATHS, envDir: OUTPUT_DIR_ENV, maxFiles: 20 } };

const requestParams = {
  owner: { in: "path", type: "string", required: true, description: "First part of the model id, e.g. fal-ai" },
  app: { in: "path", type: "string", required: true, description: "Second part of the model id without any sub-path, e.g. flux for fal-ai/flux/dev" },
  request_id: { in: "path", type: "string", required: true, description: "request_id returned by run_model" },
};

const runModel = {
  name: "run_model",
  title: "Run model",
  description: `Run a fal model through the queue and wait for the result (paid), e.g. model_id fal-ai/flux/schnell. Media URLs in the result are saved to $${OUTPUT_DIR_ENV}`,
  method: "POST",
  path: "/{+model_id}",
  write: "unsafe",
  checkHint: "the request_id is in the error; check it with get_request_status before retrying",
  bodyMode: "raw",
  params: {
    model_id: { in: "path", type: "string", required: true, description: "Model endpoint id, optionally with a sub-path, e.g. fal-ai/flux/dev or fal-ai/flux-pro/v1.1-ultra" },
    input: { in: "body", type: "object", required: true, description: 'Model inputs from the model\'s API page, e.g. {"prompt": "a red fox", "image_size": "landscape_4_3"}' },
    priority: { in: "header", type: "string", wireName: "X-Fal-Queue-Priority", enum: ["normal", "low"], description: "Queue priority within your own queue (default normal)" },
    start_timeout: { in: "header", type: "integer", wireName: "X-Fal-Request-Start-Timeout", min: 1, description: "Give up (504) if no runner starts within this many seconds" },
  },
  job: {
    idPath: "request_id",
    poll: { urlPath: "status_url" },
    result: { urlPath: "response_url" },
    statusPath: "status",
    doneValues: ["COMPLETED"],
    errorPath: "error",
    intervalMs: 1500,
    timeoutMs: 300000,
  },
  download: saveMedia,
};

const getRequestStatus = {
  name: "get_request_status",
  title: "Get request status",
  description: "Status of a queued request: IN_QUEUE (with queue_position), IN_PROGRESS or COMPLETED (with error and error_type when it failed)",
  path: `${REQUEST_PATH}/status`,
  params: { ...requestParams, logs: { in: "query", type: "integer", enum: [0, 1], description: "1 to include logs (only for the app owner)" } },
};

const getRequestResult = {
  name: "get_request_result",
  title: "Get request result",
  description: `Result of a completed request (kept 1 hour, or 6 minutes when 10 KB or larger); media URLs are saved to $${OUTPUT_DIR_ENV}`,
  path: REQUEST_PATH,
  params: requestParams,
  download: saveMedia,
};

const cancelRequest = {
  name: "cancel_request",
  title: "Cancel request",
  description: "Cancel a queued request (it never runs) or ask a running one to stop; repeating it is harmless",
  method: "PUT",
  path: `${REQUEST_PATH}/cancel`,
  write: "idempotent",
  params: requestParams,
};

const searchModels = {
  name: "search_models",
  title: "Search models",
  description: "Search fal model endpoints by text or category, or look up specific endpoint ids (with their OpenAPI schema when expanded)",
  baseUrl: PLATFORM_URL,
  path: "/v1/models",
  params: {
    q: { in: "query", type: "string", description: "Free-text search over name, description and category" },
    category: { in: "query", type: "string", description: "Category, e.g. text-to-image, image-to-video, training" },
    status: { in: "query", type: "string", enum: ["active", "deprecated"], description: "Only active or deprecated models (default both)" },
    sort: { in: "query", type: "string", enum: ["relevant", "recent"], description: "Order (default relevant)" },
    endpoint_id: { in: "query", type: "array", items: { type: "string" }, maxItems: 50, style: "repeat", description: "Look up these endpoint ids, e.g. [fal-ai/flux/dev]" },
    expand: { in: "query", type: "string", enum: ["openapi-3.0", "enterprise_status"], description: "openapi-3.0 adds each model's input/output schema" },
  },
  response: { dataPath: "models", cursorPath: "next_cursor", cursorParam: "cursor", limitParam: "limit", hasMorePath: "has_more" },
};

const getPricing = {
  name: "get_pricing",
  title: "Get pricing",
  description: "Unit price of model endpoints (per image, video second, megapixel or GPU second) for your account",
  baseUrl: PLATFORM_URL,
  path: "/v1/models/pricing",
  params: { endpoint_id: { in: "query", type: "array", items: { type: "string" }, required: true, maxItems: 50, style: "repeat", description: "Endpoint ids, e.g. [fal-ai/flux/dev]" } },
  response: { dataPath: "prices" },
};

const estimateCost = {
  name: "estimate_cost",
  title: "Estimate cost",
  description: "Estimate the cost of planned calls (historical_api_price: per call) or outputs (unit_price: per billing unit)",
  baseUrl: PLATFORM_URL,
  method: "POST",
  path: "/v1/models/pricing/estimate",
  write: "idempotent",
  params: {
    estimate_type: { in: "body", type: "string", required: true, enum: ["historical_api_price", "unit_price"], description: "historical_api_price takes call_quantity, unit_price takes unit_quantity" },
    endpoints: { in: "body", type: "object", required: true, description: 'Endpoint ids to quantities, e.g. {"fal-ai/flux/dev": {"unit_quantity": 50}} or {"fal-ai/flux/dev": {"call_quantity": 100}}' },
  },
};

const restDefinition = defineRestPlugin({
  name: "fal-ai",
  version: "0.1.0",
  description: "fal.ai: run any fal model through the queue (waits for the result, saves media files), check, fetch or cancel requests, search models and prices (paid per run)",
  apiName: "fal Queue API",
  baseUrl: "https://queue.fal.run",
  auth: { type: "header", header: "Authorization", env: "FAL_KEY", prefix: "Key " },
  extraEnv: [EXTRA_HOSTS_ENV],
  limits: LIMITS,
  // Queue errors: {"detail": "..."} (or a validation list); Platform API errors: {"error": {"type", "message"}}.
  errors: {
    messagePath: ["error.message", "detail", "detail.0.msg"],
    codePath: "error.type",
    kindByCode: { authorization_error: "auth_error", validation_error: "invalid_input", not_found: "not_found", rate_limited: "rate_limited" },
  },
  apiRequest: false,
  operations: [runModel, getRequestStatus, getRequestResult, cancelRequest, searchModels, getPricing, estimateCost],
});

const resolveAllowedHosts = (environment) => ({ hostSuffixes: DELIVERY_HOST_SUFFIXES, extraHosts: parseHostList(environment?.[EXTRA_HOSTS_ENV]) });
const findRestOperation = (operationName) => restDefinition.restSpec.operations.find((operation) => operation.name === operationName);
const wrapOperation = (operation) => {
  if (operation.name === runModel.name) return createRunModelOperation({ submitOperation: operation, restOperation: findRestOperation(runModel.name), limits: LIMITS, resolveAllowedHosts });
  if (operation.name === getRequestResult.name) return withRestrictedDownloads(operation, { saveTo: saveMedia.saveTo, budgetMs: describeTimeBudgets(LIMITS).jobBudgetCapMs, resolveAllowedHosts });
  return operation;
};

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map(wrapOperation) };
