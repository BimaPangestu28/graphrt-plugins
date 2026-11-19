/**
 * replicate plugin definition: Replicate HTTP API (https://replicate.com/docs/reference/http) built with the
 * declarative REST layer (docs/declarative-plugins.md).
 *
 * Predictions are async jobs: the create response carries `urls.get`, which is polled until `status` is
 * succeeded / failed / canceled. `output` is model-specific; when it is a URL or a list of URLs (images, audio,
 * video on replicate.delivery) the files are downloaded into $REPLICATE_OUTPUT_DIR. Predictions bill by
 * hardware time or by output, per model.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { describeTimeBudgets } from "./lib/shared/rest-spec-helpers.mjs";
import { parseHostList, withRestrictedDownloads } from "./lib/restricted-downloads.mjs";

const OUTPUT_DIR_ENV = "REPLICATE_OUTPUT_DIR";
const EXTRA_HOSTS_ENV = "REPLICATE_EXTRA_DOWNLOAD_HOSTS";
// "Output files are served by replicate.delivery and its subdomains" (replicate.com/docs/topics/predictions/output-files).
const DELIVERY_HOST_SUFFIXES = ["replicate.delivery"];
const LIMITS = { timeout_ms: 360000 };
const MODEL_PATH = "/v1/models/{model_owner}/{model_name}";

const modelParams = {
  model_owner: { in: "path", type: "string", required: true, description: "Model owner, e.g. black-forest-labs" },
  model_name: { in: "path", type: "string", required: true, description: "Model name, e.g. flux-schnell" },
};

const predictionInputs = {
  input: { in: "body", type: "object", required: true, description: 'Model inputs as described by the model\'s schema, e.g. {"prompt": "a red fox"}' },
  cancel_after: { in: "header", type: "string", wireName: "Cancel-After", description: "Cancel the prediction (and stop billing) after this long, e.g. 5m or 90s (minimum 5s)" },
};

/** Prediction job: poll urls.get, then download the output URLs. */
const predictionJob = {
  idPath: "id",
  poll: { urlPath: "urls.get" },
  statusPath: "status",
  doneValues: ["succeeded"],
  failedValues: ["failed", "canceled"],
  errorPath: "error",
  resultPath: "output",
  intervalMs: 2000,
  timeoutMs: 300000,
};
const saveOutputs = { saveTo: { urlPaths: [""], envDir: OUTPUT_DIR_ENV, maxFiles: 20 } };

/**
 * Builds a prediction-creating operation (a paid write that waits for the job).
 *
 * @param operation - `{name, title, description, path, params}` (object)
 * @returns Operation spec (object)
 */
function predictionOperation(operation) {
  return {
    ...operation,
    method: "POST",
    write: "unsafe",
    checkHint: "list_predictions shows recent predictions with their input",
    job: predictionJob,
    download: saveOutputs,
  };
}

const getAccount = { name: "get_account", title: "Get account", description: "The account that owns the API token (type, username, name)", path: "/v1/account" };

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List public models, newest version first by default",
  path: "/v1/models",
  params: {
    sort_by: { in: "query", type: "string", enum: ["latest_version_created_at", "model_created_at"], description: "Sort field (default latest_version_created_at)" },
    sort_direction: { in: "query", type: "string", enum: ["desc", "asc"], description: "Sort direction (default desc)" },
  },
  response: { dataPath: "results", nextUrlPath: "next" },
};

const searchModels = {
  name: "search",
  title: "Search models",
  description: "Search models, collections and docs by text (beta); models include generated descriptions and tags",
  path: "/v1/search",
  params: {
    query: { in: "query", type: "string", required: true, minLength: 1, description: "Search text, e.g. upscale image" },
    limit: { in: "query", type: "integer", min: 1, max: 50, description: "Maximum model results (default 20)" },
  },
};

const getModel = { name: "get_model", title: "Get model", description: "A model with its description, run count, default example and latest version (with its input/output schema)", path: MODEL_PATH, params: modelParams };

const listModelVersions = {
  name: "list_model_versions",
  title: "List model versions",
  description: "List a model's versions, newest first",
  path: `${MODEL_PATH}/versions`,
  params: modelParams,
  response: { dataPath: "results", nextUrlPath: "next" },
};

const getModelVersion = {
  name: "get_model_version",
  title: "Get model version",
  description: "A model version with its OpenAPI input/output schema",
  path: `${MODEL_PATH}/versions/{version_id}`,
  params: { ...modelParams, version_id: { in: "path", type: "string", required: true, description: "Version id (64-character hash)" } },
};

const listCollections = { name: "list_collections", title: "List collections", description: "List curated model collections", path: "/v1/collections", response: { dataPath: "results", nextUrlPath: "next" } };

const getCollection = {
  name: "get_collection",
  title: "Get collection",
  description: "A collection with its models, e.g. text-to-image",
  path: "/v1/collections/{collection_slug}",
  params: { collection_slug: { in: "path", type: "string", required: true, description: "Collection slug, e.g. text-to-image" } },
};

const listHardware = { name: "list_hardware", title: "List hardware", description: "Hardware SKUs available for models and deployments", path: "/v1/hardware" };

const runModel = predictionOperation({
  name: "run_model",
  title: "Run official model",
  description: `Run an official model (no version needed), e.g. black-forest-labs/flux-schnell, and wait for the output (paid). Output files are saved to $${OUTPUT_DIR_ENV}`,
  path: `${MODEL_PATH}/predictions`,
  params: { ...modelParams, ...predictionInputs },
});

const createPrediction = predictionOperation({
  name: "create_prediction",
  title: "Create prediction",
  description: `Run a specific model version and wait for the output (paid). Output files are saved to $${OUTPUT_DIR_ENV}`,
  path: "/v1/predictions",
  params: {
    version: { in: "body", type: "string", required: true, description: "Version id, or owner/name:version_id" },
    ...predictionInputs,
  },
});

const runDeployment = predictionOperation({
  name: "run_deployment",
  title: "Run deployment",
  description: `Run one of your deployments and wait for the output (paid; deployments also bill for idle instances). Output files are saved to $${OUTPUT_DIR_ENV}`,
  path: "/v1/deployments/{deployment_owner}/{deployment_name}/predictions",
  params: {
    deployment_owner: { in: "path", type: "string", required: true, description: "Deployment owner" },
    deployment_name: { in: "path", type: "string", required: true, description: "Deployment name" },
    ...predictionInputs,
  },
});

const getPrediction = {
  name: "get_prediction",
  title: "Get prediction",
  description: "A prediction's status (starting, processing, succeeded, failed, canceled), output, error, logs and metrics",
  path: "/v1/predictions/{prediction_id}",
  params: { prediction_id: { in: "path", type: "string", required: true, description: "Prediction id" } },
};

const listPredictions = {
  name: "list_predictions",
  title: "List predictions",
  description: "List your predictions, newest first (100 per page)",
  path: "/v1/predictions",
  params: {
    created_after: { in: "query", type: "string", description: "Only predictions created after this ISO 8601 time" },
    created_before: { in: "query", type: "string", description: "Only predictions created before this ISO 8601 time" },
    source: { in: "query", type: "string", enum: ["web"], description: "web: only predictions made on the website (last 14 days)" },
  },
  response: { dataPath: "results", nextUrlPath: "next" },
};

const cancelPrediction = {
  name: "cancel_prediction",
  title: "Cancel prediction",
  description: "Cancel a running prediction (billing stops; repeating it is harmless)",
  method: "POST",
  path: "/v1/predictions/{prediction_id}/cancel",
  write: "idempotent",
  params: { prediction_id: { in: "path", type: "string", required: true, description: "Prediction id" } },
};

const restDefinition = defineRestPlugin({
  name: "replicate",
  version: "0.1.0",
  description: "Replicate: run models and deployments as predictions (waits for the job, downloads output files), browse models, versions and collections (paid per run)",
  apiName: "Replicate HTTP API",
  baseUrl: "https://api.replicate.com",
  auth: { type: "bearer", env: "REPLICATE_API_TOKEN" },
  extraEnv: [EXTRA_HOSTS_ENV],
  limits: LIMITS,
  // Errors are problem details: {"title": "...", "detail": "...", "status": 401}.
  errors: { messagePath: ["detail", "title"], kindByStatus: { 402: "permission_denied" } },
  apiRequest: { examplePath: "/v1/account" },
  operations: [
    getAccount, searchModels, listModels, getModel, listModelVersions, getModelVersion, listCollections, getCollection, listHardware,
    runModel, createPrediction, runDeployment, getPrediction, listPredictions, cancelPrediction,
  ],
});

const restrictedDownloadSettings = {
  saveTo: saveOutputs.saveTo,
  budgetMs: describeTimeBudgets(LIMITS).jobBudgetCapMs,
  resolveAllowedHosts: (environment) => ({ hostSuffixes: DELIVERY_HOST_SUFFIXES, extraHosts: parseHostList(environment?.[EXTRA_HOSTS_ENV]) }),
};
const predictionOperationNames = new Set([runModel.name, createPrediction.name, runDeployment.name]);

export const pluginDefinition = {
  ...restDefinition,
  operations: restDefinition.operations.map((operation) => (predictionOperationNames.has(operation.name) ? withRestrictedDownloads(operation, restrictedDownloadSettings) : operation)),
};
