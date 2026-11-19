/**
 * replicate-video plugin definition: Replicate predictions (https://replicate.com/docs/reference/http) tuned for
 * video models: long polling, large downloads, model discovery (collections, search) and prediction status for
 * polling across runs. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * A prediction is a job: the create call returns `{id, status}`, the plugin polls GET /predictions/{id} until
 * `succeeded` (or `failed`/`canceled`/`aborted`) and saves the output file URLs into $REPLICATE_OUTPUT_DIR.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

// Video models often run 1–10 minutes, longer under load; outputs can be hundreds of MB.
const HOST_TIMEOUT_MS = 900000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_DIR_ENV = "REPLICATE_OUTPUT_DIR";

const predictionJob = {
  idPath: "id",
  poll: { path: "/predictions/{id}" },
  statusPath: "status",
  doneValues: ["succeeded"],
  failedValues: ["failed", "canceled", "aborted"],
  errorPath: "error",
  resultPath: "output",
  intervalMs: 5000,
};

// Video models return one URL or a list of URLs as `output`.
const outputDownload = { saveTo: { urlPaths: [""], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 20 } };
const CHECK_HINT = "list_predictions (newest first) for a prediction with the same model and input";

const predictionParams = {
  input: { in: "body", type: "object", required: true, description: "The model's input object, e.g. {\"prompt\": \"...\", \"duration\": 5}; see the model's API tab or get_model" },
  cancel_after: { in: "header", type: "string", wireName: "Cancel-After", description: "Cancel automatically after this long, e.g. 20m (stops runaway billing)" },
};

/**
 * A node-only copy of a create operation that also takes `webhook`. A webhook makes Replicate POST the prediction
 * (input and output URLs) to any host, so agents never get to choose it.
 *
 * @param operation - Create operation spec (object)
 * @returns Operation spec named `<name>_with_webhook` (object)
 */
function withWebhook(operation) {
  return {
    ...operation,
    name: `${operation.name}_with_webhook`,
    title: `${operation.title} (webhook)`,
    description: `${operation.description}; Replicate also POSTs the prediction to webhook on every update`,
    nodeOnly: true,
    params: {
      ...operation.params,
      webhook: { in: "body", type: "string", required: true, minLength: 1, description: "https URL that receives the prediction when it changes" },
      webhook_events_filter: { in: "body", type: "array", items: { type: "string", enum: ["start", "output", "logs", "completed"] }, description: "Events that trigger the webhook (default all)" },
    },
  };
}

const runModel = {
  name: "run_model",
  title: "Run model",
  description: "Run an official or latest-version model by owner/name, e.g. google/veo-3 or kwaivgi/kling-v2.1 (paid; waits and saves the video)",
  method: "POST",
  path: "/models/{model_owner}/{model_name}/predictions",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    model_owner: { in: "path", type: "string", required: true, description: "Model owner, e.g. google" },
    model_name: { in: "path", type: "string", required: true, description: "Model name, e.g. veo-3" },
    ...predictionParams,
  },
  job: predictionJob,
  download: outputDownload,
};

const runVersion = {
  name: "run_version",
  title: "Run model version",
  description: "Run a specific model version (64-character version id, or owner/name:version) (paid; waits and saves the output)",
  method: "POST",
  path: "/predictions",
  write: "unsafe",
  checkHint: CHECK_HINT,
  params: {
    version: { in: "body", type: "string", required: true, minLength: 1, description: "Version id, or owner/name:version_id" },
    ...predictionParams,
  },
  job: predictionJob,
  download: outputDownload,
};

const getPrediction = {
  name: "get_prediction",
  title: "Get prediction",
  description: "Status (starting, processing, succeeded, failed, canceled, aborted), logs, metrics and output of a prediction; saves the output when it succeeded",
  path: "/predictions/{prediction_id}",
  params: { prediction_id: { in: "path", type: "string", required: true, description: "Prediction id" } },
  download: { saveTo: { urlPaths: ["output"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_FILE_BYTES, maxFiles: 20 } },
};

const cancelPrediction = {
  name: "cancel_prediction",
  title: "Cancel prediction",
  description: "Cancel a running prediction (its partial cost is still billed)",
  method: "POST",
  path: "/predictions/{prediction_id}/cancel",
  write: "idempotent",
  nodeOnly: true,
  params: { prediction_id: { in: "path", type: "string", required: true, description: "Prediction id" } },
};

const listPredictions = {
  name: "list_predictions",
  title: "List predictions",
  description: "Predictions made with the API token's account, newest first",
  path: "/predictions",
  params: {
    created_after: { in: "query", type: "string", description: "ISO 8601 date-time" },
    created_before: { in: "query", type: "string", description: "ISO 8601 date-time" },
  },
  response: { dataPath: "results", nextUrlPath: "next" },
};

const modelPathParams = {
  model_owner: { in: "path", type: "string", required: true, description: "Model owner, e.g. minimax" },
  model_name: { in: "path", type: "string", required: true, description: "Model name, e.g. hailuo-02" },
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "A model's description, run count, default example and latest version (with its input/output schema)",
  path: "/models/{model_owner}/{model_name}",
  params: modelPathParams,
};

const listModelVersions = {
  name: "list_model_versions",
  title: "List model versions",
  description: "A model's versions, newest first",
  path: "/models/{model_owner}/{model_name}/versions",
  params: modelPathParams,
  response: { dataPath: "results", nextUrlPath: "next" },
};

const getCollection = {
  name: "get_collection",
  title: "Get collection",
  description: "Models in a Replicate collection, e.g. text-to-video or image-to-video",
  path: "/collections/{collection_slug}",
  params: { collection_slug: { in: "path", type: "string", required: true, description: "Collection slug, e.g. text-to-video" } },
};

const searchModels = {
  name: "search_models",
  title: "Search models",
  description: "Search public models, collections and docs, e.g. \"lip sync video\"",
  path: "/search",
  params: {
    query: { in: "query", type: "string", required: true, minLength: 1, description: "Search text" },
    limit: { in: "query", type: "integer", min: 1, max: 50, description: "Maximum models to return" },
  },
};

const getAccount = {
  name: "get_account",
  title: "Account",
  description: "The account (user or organization) that owns the API token",
  path: "/account",
};

export const pluginDefinition = defineRestPlugin({
  name: "replicate-video",
  version: "0.1.0",
  description: "Replicate predictions for video models (Veo, Kling, Hailuo, Wan, ...): run and wait with downloads, prediction status, model discovery",
  apiName: "Replicate HTTP API",
  baseUrl: "https://api.replicate.com/v1",
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  auth: { type: "bearer", env: "REPLICATE_API_TOKEN" },
  // Errors are problem+json: {"title", "detail", "status"}.
  errors: { messagePath: ["detail", "title"] },
  apiRequest: { examplePath: "/account" },
  operations: [runModel, runVersion, withWebhook(runModel), withWebhook(runVersion), getPrediction, cancelPrediction, listPredictions, getModel, listModelVersions, getCollection, searchModels, getAccount],
});
