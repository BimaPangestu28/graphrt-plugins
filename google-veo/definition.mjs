/**
 * google-veo plugin definition: Google Veo 3.1 video generation on Vertex AI (Gemini Enterprise Agent Platform),
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate.
 *
 * The Gemini API's Veo 3.1 previews (generativelanguage.googleapis.com, `veo-3.1-*-preview`) were shut down on
 * 2026-10-22; Google points to Gemini Omni Flash or the GA Veo models on Vertex AI. Those are served by Vertex AI's
 * long-running `predictLongRunning` + `fetchPredictOperation` endpoints, which this plugin uses with OAuth (refresh
 * token) or a node's access token.
 *
 * `get_operation` is declarative (docs/declarative-plugins.md). `generate_video` is hand-written in
 * lib/generate-video.mjs (see its header for why) and polls through `get_operation`.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { describeTimeBudgets } from "./lib/shared/rest-spec-helpers.mjs";
import { createGenerateVideoOperation, DEFAULT_VEO_MODEL } from "./lib/generate-video.mjs";

// Veo usually needs 1–3 minutes for an 8 s clip; 4K and several samples take longer.
const HOST_TIMEOUT_MS = 900000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
// A project id (my-project) or a project number (123456789012); Vertex accepts both in resource names.
const PROJECT_ID = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]{5,19})$/;
// Inline videos arrive base64-encoded in the operation response; give that read more than the default 30 s.
const GET_OPERATION_TIMEOUT_MS = 300000;
const LOCATION = /^[a-z]+-[a-z]+[0-9]+$/;

/**
 * Builds the Vertex AI base URL from GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION (default us-central1).
 *
 * @param environment - Environment variables (object)
 * @returns `https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>` (string)
 * @throws Error - When the project id or location is missing or malformed (becomes invalid_input)
 */
function resolveVertexBaseUrl(environment) {
  const projectId = (environment.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const location = (environment.GOOGLE_CLOUD_LOCATION ?? "").trim() || "us-central1";
  if (!PROJECT_ID.test(projectId)) throw new Error("set GOOGLE_CLOUD_PROJECT to your Google Cloud project id or project number");
  if (!LOCATION.test(location)) throw new Error("GOOGLE_CLOUD_LOCATION must be a region such as us-central1");
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}`;
}

const getOperation = {
  name: "get_operation",
  title: "Get operation",
  description: "State of a Veo operation (done, error, videos as gs:// URIs or inline bytes); saves inline videos of a finished one into GOOGLE_VEO_OUTPUT_DIR",
  method: "POST",
  path: "/publishers/google/models/{model}:fetchPredictOperation",
  write: "idempotent",
  timeoutMs: GET_OPERATION_TIMEOUT_MS,
  params: {
    model: { in: "path", type: "string", required: true, description: `Model that started the operation, e.g. ${DEFAULT_VEO_MODEL}` },
    operation_name: { in: "body", type: "string", required: true, minLength: 1, wireName: "operationName", description: "Full operation name from generate_video (projects/.../operations/...)" },
  },
  download: { saveTo: { base64Paths: ["response.videos[].bytesBase64Encoded"], envDir: "GOOGLE_VEO_OUTPUT_DIR", maxBytes: MAX_VIDEO_BYTES, maxFiles: 4 } },
};

const restDefinition = defineRestPlugin({
  name: "google-veo",
  version: "0.1.0",
  description: "Google Veo 3.1 on Vertex AI: text, image (first/last frame) and extend to video as long-running operations, with inline video saving",
  apiName: "Vertex AI Veo API",
  baseUrl: resolveVertexBaseUrl,
  allowedHostSuffix: ".googleapis.com",
  extraEnv: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  auth: {
    type: "oauth2",
    grant: "refresh_token",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    refreshTokenEnv: "GOOGLE_REFRESH_TOKEN",
  },
  // Google errors: {"error": {"code": 400, "message": "...", "status": "INVALID_ARGUMENT"}}.
  errors: {
    messagePath: "error.message",
    codePath: "error.status",
    // HTTP statuses already give 401 auth_error, 403 permission_denied, 404 not_found and 429 rate_limited.
    kindByCode: { FAILED_PRECONDITION: "invalid_input", RESOURCE_EXHAUSTED: "rate_limited" },
  },
  apiRequest: { examplePath: "/publishers/google/models/veo-3.1-generate-001" },
  operations: [getOperation],
});

const generateVideo = createGenerateVideoOperation({
  getOperation: restDefinition.operations.find((operation) => operation.name === "get_operation"),
  jobBudgetCapMs: describeTimeBudgets(restDefinition.limits).jobBudgetCapMs,
});

export const pluginDefinition = { ...restDefinition, operations: [generateVideo, ...restDefinition.operations] };
