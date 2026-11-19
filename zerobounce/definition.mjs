/**
 * zerobounce plugin definition: ZeroBounce email validation API v2 (https://www.zerobounce.net/docs/email-validation-api-quickstart/).
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Hosts: real-time calls go to api.zerobounce.net, api-us.zerobounce.net (US-only processing) or
 * api-eu.zerobounce.net (ZEROBOUNCE_REGION); bulk file calls go to bulkapi.zerobounce.net (ZeroBounce documents no
 * regional bulk host). v2 takes the API key as the `api_key` query parameter, so the layer's query auth sends it
 * and redacts it from every error, result and cursor. Two endpoints read the key from the body instead
 * (validatebatch: JSON, sendfile: a multipart field); lib/body-api-key.mjs adds it there from the run's credential
 * and hides it from the operation's parameters.
 *
 * Agent policy: validate_email spends credits: `unsafe` (never retried after an unknown outcome). validate_batch
 * (up to 100 addresses) needs ZEROBOUNCE_TOOL_ALLOW_BATCH=1 as a tool. Bulk files (send, status, get, delete) are
 * node only; local files must be inside ZEROBOUNCE_FILE_DIR and results are saved to ZEROBOUNCE_OUTPUT_DIR.
 * api_request as a tool may only read /getcredits and /getapiusage (/validate is a billed GET).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { restrictApiRequestToReadPaths } from "./lib/api-request-allowlist.mjs";
import { addBodyApiKeyParam, injectBodyApiKey } from "./lib/body-api-key.mjs";
import { rejectJsonErrorFile } from "./lib/result-file.mjs";

export const BATCH_OPT_IN_ENV = "ZEROBOUNCE_TOOL_ALLOW_BATCH";
export const FILE_DIR_ENV = "ZEROBOUNCE_FILE_DIR";
export const OUTPUT_DIR_ENV = "ZEROBOUNCE_OUTPUT_DIR";
export const REGION_ENV = "ZEROBOUNCE_REGION";
export const TOOL_READ_PATH_PREFIXES = ["/getcredits", "/getapiusage"];
export const MAX_BATCH_EMAILS = 100;
const REGIONAL_HOSTS = { default: "api.zerobounce.net", us: "api-us.zerobounce.net", eu: "api-eu.zerobounce.net" };
const BULK_API = "https://bulkapi.zerobounce.net/v2";
const CREDIT_CHECK_HINT = "get_credits or get_api_usage for today before validating again (unknown results are not charged)";
const INVALID_KEY_MESSAGE = "Invalid API key or your account ran out of credits";
const INVALID_KEY_PATTERN = /invalid api key/i;

/**
 * The regional real-time API base URL.
 *
 * @param environment - Environment variables (object)
 * @returns e.g. "https://api-eu.zerobounce.net/v2" (string)
 * @throws Error - ZEROBOUNCE_REGION is not default, us or eu (becomes invalid_input)
 */
export function resolveRegionalBaseUrl(environment) {
  const region = (environment[REGION_ENV] ?? "").trim().toLowerCase() || "default";
  const host = REGIONAL_HOSTS[region];
  if (!host) throw new Error(`${REGION_ENV} must be default, us or eu`);
  return `https://${host}/v2`;
}

const FILE_ID = { in: "query", type: "string", required: true, minLength: 1, description: "file_id returned by send_file" };
const validationOptions = {
  activity_data: { type: "boolean", description: "Append activity data (last seen active, in days)" },
  verify_plus: { type: "boolean", description: "Use Verify+ (overrides the account setting)" },
};
const inQuery = (spec) => ({ ...spec, in: "query" });
const inBody = (spec) => ({ ...spec, in: "body" });

const realtimeOperations = [
  {
    name: "validate_email",
    title: "Validate email",
    description: "Validate one address: status (valid, invalid, catch-all, unknown, spamtrap, abuse, do_not_mail), sub_status, did_you_mean, domain age, MX (1 credit; unknown results are free)",
    method: "GET",
    path: "/validate",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    timeoutMs: 75000,
    params: {
      email: { in: "query", type: "string", required: true, minLength: 3 },
      ip_address: { in: "query", type: "string", description: "IP the address signed up from (optional)" },
      validation_timeout: { in: "query", type: "integer", min: 3, max: 60, wireName: "timeout", description: "Seconds ZeroBounce may spend (3-60, default 30); past it the result is unknown" },
      activity_data: inQuery(validationOptions.activity_data),
      verify_plus: inQuery(validationOptions.verify_plus),
    },
  },
  addBodyApiKeyParam({
    name: "validate_batch",
    title: "Validate batch",
    description: `Validate up to ${MAX_BATCH_EMAILS} addresses in one call (can take up to 70 s; 1 credit each, unknown results free)`,
    method: "POST",
    path: "/validatebatch",
    write: "unsafe",
    checkHint: CREDIT_CHECK_HINT,
    toolPolicy: `optIn:${BATCH_OPT_IN_ENV}`,
    timeoutMs: 130000,
    params: {
      email_batch: {
        in: "body",
        type: "array",
        items: { type: "object" },
        required: true,
        maxItems: MAX_BATCH_EMAILS,
        description: 'Addresses, e.g. [{"email_address": "ada@example.com", "ip_address": null}]',
      },
      validation_timeout: { in: "body", type: "integer", min: 10, max: 120, wireName: "timeout", description: "Seconds for the whole batch (10-120)" },
      activity_data: inBody(validationOptions.activity_data),
      verify_plus: inBody(validationOptions.verify_plus),
    },
  }),
  { name: "get_credits", title: "Credit balance", description: "Remaining validation credits (free)", path: "/getcredits", response: { dataPath: "Credits" } },
  {
    name: "get_api_usage",
    title: "API usage",
    description: "API calls and result counts by status and sub_status between two dates (free)",
    path: "/getapiusage",
    params: {
      start_date: { in: "query", type: "string", required: true, description: "YYYY-MM-DD" },
      end_date: { in: "query", type: "string", required: true, description: "YYYY-MM-DD" },
    },
  },
];

const bulkOperations = [
  addBodyApiKeyParam({
    name: "send_file",
    title: "Send file",
    description: "Upload a CSV or TXT file for bulk validation (1 credit per address; return_url gets a POST when done)",
    baseUrl: BULK_API,
    method: "POST",
    path: "/sendfile",
    bodyMode: "multipart",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_file_status, or the file list in the ZeroBounce dashboard, before uploading again",
    multipart: { fileDirEnv: FILE_DIR_ENV, maxFileBytes: 200 * 1024 * 1024 },
    timeoutMs: 280000,
    params: {
      file: { in: "body", type: "string", file: true, required: true, description: "CSV or TXT file" },
      email_address_column: { in: "body", type: "integer", required: true, min: 1, description: "1-based column of the email address" },
      first_name_column: { in: "body", type: "integer", min: 1 },
      last_name_column: { in: "body", type: "integer", min: 1 },
      gender_column: { in: "body", type: "integer", min: 1 },
      ip_address_column: { in: "body", type: "integer", min: 1 },
      has_header_row: { in: "body", type: "boolean" },
      remove_duplicate: { in: "body", type: "boolean", description: "Remove duplicate addresses (default true; more than 50% duplicates is a 400)" },
      allow_phase_2: { in: "body", type: "boolean", description: "Run Verify+ catch-all validation (phase 2) after the first pass" },
      return_url: { in: "body", type: "string", description: "URL ZeroBounce POSTs {file_id, file_name, upload_date} to when done" },
    },
  }),
  {
    name: "get_file_status",
    title: "File status",
    description: "Processing status and percentage of an uploaded file",
    baseUrl: BULK_API,
    path: "/filestatus",
    nodeOnly: true,
    params: { file_id: FILE_ID },
  },
  {
    name: "get_file",
    title: "Get result file",
    description: `Download the validation results of a finished file (CSV) into ${OUTPUT_DIR_ENV}`,
    baseUrl: BULK_API,
    path: "/getfile",
    nodeOnly: true,
    timeoutMs: 280000,
    params: {
      file_id: FILE_ID,
      activity_data: inQuery({ type: "boolean", description: "Append activity data columns" }),
      download_type: { in: "query", type: "string", enum: ["phase_1", "phase_2", "combined"], description: "Verify+ phase results (phase_2 and combined need phase 2 to be complete)" },
    },
    response: { binary: { envDir: OUTPUT_DIR_ENV, maxBytes: 500 * 1024 * 1024 } },
  },
  {
    name: "delete_file",
    title: "Delete file",
    description: "Delete an uploaded file and its results (only when its status is Complete)",
    baseUrl: BULK_API,
    method: "GET",
    path: "/deletefile",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_file_status",
    params: { file_id: FILE_ID },
  },
];

export const restDefinition = defineRestPlugin({
  name: "zerobounce",
  version: "0.1.0",
  description: "ZeroBounce email validation API v2 (default, US or EU host): validate one address (credits), batches of up to 100 (agent opt-in), credits and usage; bulk file upload, status, results and delete are node only",
  apiName: "ZeroBounce API v2",
  baseUrl: resolveRegionalBaseUrl,
  limits: { timeout_ms: 300000 },
  auth: { type: "query", param: "api_key", env: "ZEROBOUNCE_API_KEY" },
  extraEnv: [REGION_ENV],
  errors: {
    // Real-time errors are 200 bodies {"error": "..."}; bulk ones {"success": false, "message": "..."}.
    // The error text is the only code ZeroBounce gives; mapInvalidKeyError turns the invalid-key text into auth_error.
    messagePath: ["error", "message", "Message"],
    errorPath: "error",
    okPath: "success",
    okValue: true,
  },
  apiRequest: { examplePath: "/getcredits" },
  operations: [...realtimeOperations, ...bulkOperations],
});

/**
 * getcredits answers 200 {"Credits": "-1"} for an invalid key; that becomes an auth_error.
 *
 * @param operation - get_credits operation (object)
 * @returns Operation that refuses the -1 balance (object)
 */
export function rejectInvalidKeyBalance(operation) {
  return {
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      if (String(result?.data) !== "-1") return result;
      throw new PluginError(`API error: ${INVALID_KEY_MESSAGE} (getcredits returned -1)`, { kind: "auth_error" });
    },
  };
}

/**
 * ZeroBounce reports a bad key as 200 {"error": "Invalid API key or your account ran out of credits"} (no code
 * field), which the layer maps to api_error; this makes it an auth_error.
 *
 * @param operation - Operation (object)
 * @returns Operation with the mapping (object)
 */
export function mapInvalidKeyError(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        if (!(operationError instanceof PluginError) || !INVALID_KEY_PATTERN.test(operationError.message)) throw operationError;
        throw new PluginError(operationError.message, { kind: "auth_error" });
      }
    },
  };
}

const BODY_API_KEY_OPERATIONS = ["validate_batch", "send_file"];
const WRAPPERS = { get_credits: rejectInvalidKeyBalance, get_file: rejectJsonErrorFile };

/**
 * Applies the plugin's wrappers and (unless turned off for the contract suite, whose api_request probe uses an
 * arbitrary path) the api_request tool path allowlist.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param options - `{guardApiRequestPaths}` (object)
 * @returns Wrapped definition (object)
 */
export function wrapZeroBounceDefinition(definition, { guardApiRequestPaths = true } = {}) {
  const operations = definition.operations.map((operation) => {
    if (WRAPPERS[operation.name]) return mapInvalidKeyError(WRAPPERS[operation.name](operation));
    if (guardApiRequestPaths && operation.name === "api_request") return mapInvalidKeyError(restrictApiRequestToReadPaths(operation, TOOL_READ_PATH_PREFIXES));
    return mapInvalidKeyError(operation);
  });
  return injectBodyApiKey({ ...definition, operations }, BODY_API_KEY_OPERATIONS);
}

export const pluginDefinition = wrapZeroBounceDefinition(restDefinition);
