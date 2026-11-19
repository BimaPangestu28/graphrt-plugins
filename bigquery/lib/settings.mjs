/**
 * bigquery configuration from the environment: default project and location, the bytes-billed cap every query
 * carries, result size and wait limits, and the agent write opt-in.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOOL_WRITES_VARIABLE = "BIGQUERY_TOOL_ALLOW_WRITES";
export const MAX_BYTES_BILLED_VARIABLE = "BIGQUERY_MAX_BYTES_BILLED";
export const SETTING_VARIABLES = ["BIGQUERY_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "BIGQUERY_LOCATION", MAX_BYTES_BILLED_VARIABLE, "BIGQUERY_MAX_RESULT_BYTES", "BIGQUERY_QUERY_TIMEOUT_MS", TOOL_WRITES_VARIABLE];
export const DEFAULT_MAX_BYTES_BILLED = 1024 ** 3;
const PROJECT_ID_PATTERN = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const LOCATION_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,40}$/;
const NUMBER_LIMITS = {
  [MAX_BYTES_BILLED_VARIABLE]: { fallback: DEFAULT_MAX_BYTES_BILLED, min: 1, max: 10 ** 15 },
  BIGQUERY_MAX_RESULT_BYTES: { fallback: 2000000, min: 1000, max: 10000000 },
  BIGQUERY_QUERY_TIMEOUT_MS: { fallback: 30000, min: 1000, max: 90000 },
};

/**
 * Reads and validates the settings.
 *
 * @param environment - Environment variables (object)
 * @returns `{projectId, location, maxBytesBilled, maxResultBytes, queryTimeoutMs, allowToolWrites}` (object)
 * @throws PluginError kind `invalid_input` - When a value is malformed (the message names the variable)
 */
export function resolveSettings(environment) {
  const projectId = readVariable(environment, "BIGQUERY_PROJECT_ID") ?? readVariable(environment, "GOOGLE_CLOUD_PROJECT");
  const location = readVariable(environment, "BIGQUERY_LOCATION");
  if (projectId !== undefined) checkProjectId(projectId, "BIGQUERY_PROJECT_ID");
  if (location !== undefined) checkLocation(location, "BIGQUERY_LOCATION");
  return {
    projectId,
    location,
    maxBytesBilled: readNumber(environment, MAX_BYTES_BILLED_VARIABLE),
    maxResultBytes: readNumber(environment, "BIGQUERY_MAX_RESULT_BYTES"),
    queryTimeoutMs: readNumber(environment, "BIGQUERY_QUERY_TIMEOUT_MS"),
    allowToolWrites: environment?.[TOOL_WRITES_VARIABLE] === "1",
  };
}

/**
 * Checks a project id (also domain-scoped ids like example.com:my-project).
 *
 * @param projectId - Project id (string)
 * @param label - Argument or variable name, for the message (string)
 * @returns The project id (string)
 * @throws PluginError kind `invalid_input`
 */
export function checkProjectId(projectId, label) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new PluginError(`${label} ${JSON.stringify(projectId)} is not a Google Cloud project id`, { kind: "invalid_input" });
  return projectId;
}

/**
 * Checks a BigQuery location such as US, EU or asia-southeast1.
 *
 * @param location - Location (string)
 * @param label - Argument or variable name (string)
 * @returns The location (string)
 * @throws PluginError kind `invalid_input`
 */
export function checkLocation(location, label) {
  if (!LOCATION_PATTERN.test(location)) throw new PluginError(`${label} ${JSON.stringify(location)} is not a BigQuery location such as US, EU or asia-southeast1`, { kind: "invalid_input" });
  return location;
}

/**
 * The project for a call: the argument, else the default.
 *
 * @param args - Validated arguments with optional `project_id` (object)
 * @param settings - From resolveSettings (object)
 * @returns Project id (string)
 * @throws PluginError kind `invalid_input` - When neither is set
 */
export function pickProjectId(args, settings) {
  if (args.project_id !== undefined) return checkProjectId(args.project_id, "`project_id`");
  if (settings.projectId) return settings.projectId;
  throw new PluginError("No project: pass `project_id` or set BIGQUERY_PROJECT_ID", { kind: "invalid_input" });
}

function readNumber(environment, variableName) {
  const { fallback, min, max } = NUMBER_LIMITS[variableName];
  const rawValue = readVariable(environment, variableName);
  if (rawValue === undefined) return fallback;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PluginError(`${variableName} must be an integer from ${min} to ${max}`, { kind: "invalid_input" });
  }
  return value;
}

function readVariable(environment, variableName) {
  const value = environment?.[variableName];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
