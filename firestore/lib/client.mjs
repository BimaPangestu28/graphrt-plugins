/**
 * Firestore REST v1 client: settings (project, database, write opt-in), Bearer auth from the Google credentials
 * (google-auth.mjs) and Google error mapping. The base URL is the database (projects/<p>/databases/<db>), so
 * operation paths are `/documents/<path>` and `/documents:runQuery`.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createAccessTokenSource } from "./google-auth.mjs";
import { parseGoogleError } from "./google-errors.mjs";

export const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
export const TOOL_WRITES_VARIABLE = "FIRESTORE_TOOL_ALLOW_WRITES";
export const SETTING_VARIABLES = ["FIRESTORE_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "FIRESTORE_DATABASE", "FIRESTORE_MAX_RESULT_BYTES", TOOL_WRITES_VARIABLE];
const DEFAULT_MAX_RESULT_BYTES = 4000000;
const PROJECT_ID_PATTERN = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const DATABASE_ID_PATTERN = /^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;

/**
 * Reads and validates the settings.
 *
 * @param environment - Environment variables (object)
 * @returns `{projectId, databaseId, maxResultBytes, allowToolWrites, databaseName}`; databaseName is projects/<p>/databases/<db> (object)
 * @throws PluginError kind `invalid_input` - Missing or malformed project or database id
 */
export function resolveSettings(environment) {
  const projectId = readVariable(environment, "FIRESTORE_PROJECT_ID") ?? readVariable(environment, "GOOGLE_CLOUD_PROJECT");
  const databaseId = readVariable(environment, "FIRESTORE_DATABASE") ?? "(default)";
  if (!projectId) throw new PluginError("No project: set FIRESTORE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT)", { kind: "invalid_input" });
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new PluginError(`FIRESTORE_PROJECT_ID ${JSON.stringify(projectId)} is not a Google Cloud project id`, { kind: "invalid_input" });
  if (!DATABASE_ID_PATTERN.test(databaseId)) throw new PluginError(`FIRESTORE_DATABASE ${JSON.stringify(databaseId)} is not a database id ((default) or lowercase letters, digits and -)`, { kind: "invalid_input" });
  const maxResultBytes = readMaxResultBytes(environment);
  return { projectId, databaseId, maxResultBytes, allowToolWrites: environment?.[TOOL_WRITES_VARIABLE] === "1", databaseName: `projects/${projectId}/databases/${databaseId}` };
}

function readMaxResultBytes(environment) {
  const rawValue = readVariable(environment, "FIRESTORE_MAX_RESULT_BYTES");
  if (rawValue === undefined) return DEFAULT_MAX_RESULT_BYTES;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1000 || value > 32000000) throw new PluginError("FIRESTORE_MAX_RESULT_BYTES must be an integer from 1000 to 32000000", { kind: "invalid_input" });
  return value;
}

function readVariable(environment, variableName) {
  const value = environment?.[variableName];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Creates the client the operations receive.
 *
 * @param runnerInputs - `{accessToken, environment, fetchImpl}`; accessToken is the result of resolveGoogleCredentials (object)
 * @returns Shared API client `{request, requestWithHeaders}` plus `settings` (object)
 */
export function createFirestoreClient({ accessToken: credentials, environment, fetchImpl }) {
  const settings = resolveSettings(environment);
  const tokenSource = createAccessTokenSource(credentials, { scope: FIRESTORE_SCOPE, fetchImpl });
  const apiClient = createApiClient({
    baseUrl: `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(settings.projectId)}/databases/${encodeURIComponent(settings.databaseId)}`,
    authorize: async ({ headers }) => {
      headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
    },
    refreshCredentials: tokenSource.refreshAccessToken,
    parseError: parseGoogleError,
    fetchImpl,
  });
  return { ...apiClient, settings };
}

/**
 * Refuses a write from an agent tool unless FIRESTORE_TOOL_ALLOW_WRITES=1.
 *
 * @param context - Operation context `{source, client}` (object)
 * @param operationName - For the message (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolWriteAllowed({ source, client }, operationName) {
  if (source !== "tool" || client.settings.allowToolWrites) return;
  throw new PluginError(`\`${operationName}\` is disabled for agent tools; set ${TOOL_WRITES_VARIABLE}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
}
