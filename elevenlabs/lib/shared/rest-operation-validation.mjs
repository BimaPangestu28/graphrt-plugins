/**
 * Load-time validation of one declarative REST operation (called by rest-spec-validation.mjs).
 *
 * Checks names, method and write class, params (location, type, wireName, default/enum types, styles, files),
 * path placeholders, body modes and constants, pagination, binary responses, jobs, downloads and time budgets.
 */
import { findForbiddenSegments } from "./object-path.mjs";
import {
  BODY_MODES,
  checkBaseUrl,
  checkEnvName,
  checkHeaderName,
  describePaginationWireNames,
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeTimeBudgets,
  FORM_ARRAY_STYLES,
  HTTP_METHODS,
  JOB_WAIT_PARAM,
  listPlaceholders,
  MIN_JOB_BUDGET_MS,
  PAGINATION_PARAM_NAMES,
  paginationStyles,
  PARAM_LOCATIONS,
  PARAM_TYPES,
  QUERY_ARRAY_STYLES,
  READ_METHODS,
  rejectUnknownKeys,
  requireText,
  TOOL_POLICY_PATTERN,
  validateRequestTimeout,
  validateToolOutput,
  WRITE_CLASSES,
} from "./rest-spec-helpers.mjs";

const OPERATION_KEYS = [
  "name", "title", "description", "baseUrl", "sendCredential", "method", "path", "params", "bodyMode", "contentType", "formArrays",
  "multipart", "fileBody", "constants", "idempotencyKeyHeader", "write", "checkHint", "nodeOnly", "toolPolicy", "response", "job", "download",
  "timeoutMs", "minRequestMs", "toolOutput",
];
const PARAM_KEYS = ["in", "type", "required", "description", "enum", "min", "max", "default", "wireName", "items", "maxItems", "minLength", "style", "file"];
const RESPONSE_KEYS = ["dataPath", "cursorPath", "cursorParam", "limitParam", "hasMorePath", "nextLinkHeader", "nextUrlPath", "lastItemCursor", "pagePagination", "offsetPagination", "maxLimit", "defaultLimit", "paramsIn", "binary"];
const PAGE_PAGINATION_KEYS = ["pageParam", "sizeParam", "firstPage", "totalPagesPath"];
const OFFSET_PAGINATION_KEYS = ["offsetParam", "limitParam", "totalPath"];
const LAST_ITEM_KEYS = ["itemIdPath", "param", "hasMorePath"];
const BINARY_KEYS = ["envDir", "maxBytes"];
const JOB_KEYS = ["idPath", "poll", "result", "allowedHosts", "statusPath", "doneValues", "failedValues", "errorPath", "resultPath", "intervalMs", "timeoutMs"];
const POLL_KEYS = ["method", "path", "urlPath", "params"];
const JOB_RESULT_KEYS = ["method", "path", "urlPath"];
const SAVE_TO_KEYS = ["urlPaths", "base64Paths", "envDir", "maxBytes", "maxFiles"];
const FILE_SETTINGS_KEYS = ["fileDirEnv", "maxFileBytes"];
const FILE_BODY_MODES = ["multipart", "file"];
const CONSTANT_KEYS = ["query", "body", "headers"];
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const MAX_DOWNLOAD_FILES = 50;
const VALUE_CHECKERS = {
  string: (value) => typeof value === "string",
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
};

/**
 * Validates one operation spec, throwing through `fail` on the first problem.
 *
 * @param spec - The whole plugin spec, for auth, limits and defaults (object)
 * @param operation - Operation spec (object)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function validateOperation(spec, operation, fail) {
  rejectUnknownKeys(operation, OPERATION_KEYS, "operation", fail);
  const method = validateBasics(spec, operation, fail);
  validateWriteClass(operation, method, fail);
  validateParams(spec, operation, method, fail);
  validatePathPlaceholders(operation, fail);
  validateBody(operation, method, fail);
  validateConstants(operation, fail);
  validateResponse(operation, method, fail);
  validateJob(spec, operation, fail);
  validateDownload(operation, fail);
}

function validateBasics(spec, operation, fail) {
  if (typeof operation.name !== "string" || !SNAKE_CASE.test(operation.name)) fail("`name` must be snake_case");
  requireText(operation.title, "`title`", fail);
  requireText(operation.description, "`description`", fail);
  const method = (operation.method ?? "GET").toUpperCase();
  if (!HTTP_METHODS.includes(method)) fail(`method \`${operation.method}\` is unknown; use one of ${HTTP_METHODS.join(", ")}`);
  if (typeof operation.path !== "string" || !operation.path.startsWith("/")) fail('`path` must start with "/"');
  if (operation.baseUrl !== undefined && typeof operation.baseUrl !== "function") checkBaseUrl(operation.baseUrl, fail);
  if (operation.sendCredential !== undefined && (operation.baseUrl === undefined || typeof operation.sendCredential !== "boolean")) {
    fail("`sendCredential` (boolean) is only for operations with their own `baseUrl`");
  }
  if (operation.toolPolicy !== undefined && !TOOL_POLICY_PATTERN.test(operation.toolPolicy)) fail('`toolPolicy` must be "optIn:<ENV_NAME>"');
  if (operation.idempotencyKeyHeader !== undefined && operation.idempotencyKeyHeader !== false) checkHeaderName(operation.idempotencyKeyHeader, "idempotencyKeyHeader", fail);
  validateToolOutput(operation.toolOutput, "toolOutput", fail);
  validateRequestTimeout(operation.timeoutMs, spec.limits, "timeoutMs", fail);
  validateFileInputBudget(spec, operation, fail);
  return method;
}

// File inputs are read before the request inside the call's budget, so the request's minimum must leave time.
function validateFileInputBudget(spec, operation, fail) {
  const hasFiles = Object.values(operation.params ?? {}).some((paramSpec) => paramSpec.file === true);
  if (operation.minRequestMs !== undefined && !hasFiles) fail("`minRequestMs` is only for operations with file inputs (`file: true` params)");
  if (!hasFiles) return;
  const requestTimeoutMs = operation.timeoutMs ?? spec.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const minRequestMs = operation.minRequestMs ?? requestTimeoutMs;
  if (!Number.isInteger(minRequestMs) || minRequestMs <= 0 || minRequestMs > requestTimeoutMs) fail(`minRequestMs must be a positive integer, at most the request's timeoutMs ${requestTimeoutMs}`);
  const { hostTimeoutMs, requestTimeoutCapMs } = describeTimeBudgets(spec.limits);
  if (minRequestMs >= requestTimeoutCapMs) {
    fail(`file inputs are read before a request that needs ${minRequestMs} ms, and limits.timeout_ms ${hostTimeoutMs} minus 10 s leaves no time for them; raise limits.timeout_ms or set minRequestMs`);
  }
}

function validateWriteClass(operation, method, fail) {
  if (operation.write === undefined) {
    if (!READ_METHODS.has(method)) fail(`${method} operations must declare \`write\`: "idempotent" (safe to repeat) or "unsafe" (creates or sends)`);
    return;
  }
  if (!WRITE_CLASSES.includes(operation.write)) fail(`write class \`${operation.write}\` is unknown; use one of ${WRITE_CLASSES.join(", ")}`);
  if (operation.write === "read" && !READ_METHODS.has(method)) fail('`write: "read"` is only for GET/HEAD; a POST that only reads is "idempotent"');
}

// --- params ------------------------------------------------------------------------------------

function validateParams(spec, operation, method, fail) {
  const params = operation.params ?? {};
  for (const [paramName, paramSpec] of Object.entries(params)) {
    validateParam(spec, operation, method, paramName, paramSpec, fail);
  }
  rejectDuplicateWireNames(params, fail);
  const reservedNames = [...(paginationStyles(operation.response).length > 0 ? PAGINATION_PARAM_NAMES : []), ...(operation.job ? [JOB_WAIT_PARAM] : [])];
  for (const reservedName of reservedNames) {
    if (Object.hasOwn(params, reservedName)) fail(`param \`${reservedName}\` is reserved: it is generated for this operation`);
  }
}

function validateParam(spec, operation, method, paramName, paramSpec, fail) {
  const failParam = (problem) => fail(`param \`${paramName}\`: ${problem}`);
  if (paramName === "access_token") failParam("`access_token` is reserved for the node credential override");
  rejectUnknownKeys(paramSpec, PARAM_KEYS, "param", failParam);
  if (!PARAM_LOCATIONS.includes(paramSpec.in)) failParam(`\`in\` must be one of ${PARAM_LOCATIONS.join(", ")}`);
  if (!PARAM_TYPES.includes(paramSpec.type)) failParam(`type \`${paramSpec.type}\` is unknown; use one of ${PARAM_TYPES.join(", ")}`);
  validateWireName(paramSpec, failParam);
  if (paramSpec.in === "path" && paramSpec.required !== true) fail(`path param \`${paramName}\` must be required`);
  if (paramSpec.in === "body" && READ_METHODS.has(method)) {
    fail(`${method} cannot have body params (\`${paramName}\`): Node's fetch cannot send a ${method} body; use POST with \`write: "idempotent"\` for searches, or \`in: "query"\``);
  }
  validateValueTypes(paramSpec, failParam);
  validateStyleAndFile(operation, paramSpec, failParam);
  checkCredentialCollision(spec.auth, paramName, paramSpec, failParam);
}

function validateWireName(paramSpec, failParam) {
  if (paramSpec.wireName === undefined) return;
  requireText(paramSpec.wireName, "`wireName`", failParam);
  if (paramSpec.in === "header") checkHeaderName(paramSpec.wireName, "wireName", failParam);
  const forbiddenSegments = paramSpec.in === "body" ? findForbiddenSegments(paramSpec.wireName) : [];
  if (forbiddenSegments.length > 0) failParam(`wireName segment \`${forbiddenSegments[0]}\` is not allowed`);
}

function validateValueTypes(paramSpec, failParam) {
  const isOfType = VALUE_CHECKERS[paramSpec.type];
  if (paramSpec.enum !== undefined && (!Array.isArray(paramSpec.enum) || !paramSpec.enum.every(isOfType))) failParam(`every enum value must be of type ${paramSpec.type}`);
  if (paramSpec.default === undefined) return;
  if (!isOfType(paramSpec.default)) failParam(`default ${JSON.stringify(paramSpec.default)} is not of type ${paramSpec.type}`);
  if (paramSpec.enum && !paramSpec.enum.includes(paramSpec.default)) failParam(`default ${JSON.stringify(paramSpec.default)} is not in the enum`);
}

function validateStyleAndFile(operation, paramSpec, failParam) {
  if (paramSpec.style !== undefined && (paramSpec.in !== "query" || paramSpec.type !== "array" || !QUERY_ARRAY_STYLES.includes(paramSpec.style))) {
    failParam(`style is only for query arrays: one of ${QUERY_ARRAY_STYLES.join(", ")}`);
  }
  if (paramSpec.file !== undefined && (paramSpec.file !== true || !FILE_BODY_MODES.includes(operation.bodyMode) || paramSpec.in !== "body" || paramSpec.type !== "string")) {
    failParam('`file: true` needs bodyMode "multipart" or "file", `in: "body"` and type string');
  }
}

function checkCredentialCollision(auth, paramName, paramSpec, failParam) {
  const wireName = String(paramSpec.wireName ?? paramName).toLowerCase();
  if (paramSpec.in === "header" && (wireName === "authorization" || wireName === String(auth?.header ?? "").toLowerCase())) {
    failParam(`header \`${wireName}\` carries the credential (authorization) and cannot be a param`);
  }
  if (paramSpec.in === "query" && auth?.type === "query" && wireName === String(auth.param).toLowerCase()) {
    failParam(`query \`${wireName}\` carries the credential and cannot be a param`);
  }
}

function rejectDuplicateWireNames(params, fail) {
  const seenWireNames = new Set();
  for (const [paramName, paramSpec] of Object.entries(params)) {
    const wireName = paramSpec.wireName ?? paramName;
    const key = `${paramSpec.in}:${paramSpec.in === "header" ? wireName.toLowerCase() : wireName}`;
    if (seenWireNames.has(key)) fail(`duplicate ${paramSpec.in} wireName \`${wireName}\``);
    seenWireNames.add(key);
  }
}

function validatePathPlaceholders(operation, fail) {
  const params = operation.params ?? {};
  const placeholderNames = listPlaceholders(operation.path).map((placeholder) => placeholder.name);
  for (const placeholderName of placeholderNames) {
    if (params[placeholderName]?.in !== "path") fail(`path placeholder {${placeholderName}} has no \`in: "path"\` param`);
  }
  for (const [paramName, paramSpec] of Object.entries(params)) {
    if (paramSpec.in === "path" && !placeholderNames.includes(paramName)) fail(`path param \`${paramName}\` is not used in path ${operation.path}`);
  }
}

// --- body and constants -------------------------------------------------------------------------

function validateBody(operation, method, fail) {
  const bodyMode = operation.bodyMode ?? "json";
  if (!BODY_MODES.includes(bodyMode)) fail(`bodyMode \`${operation.bodyMode}\` is unknown; use one of ${BODY_MODES.join(", ")}`);
  const bodyParams = Object.values(operation.params ?? {}).filter((paramSpec) => paramSpec.in === "body");
  if (bodyMode === "raw" && (bodyParams.length !== 1 || !["object", "array"].includes(bodyParams[0].type))) fail('bodyMode "raw" needs exactly one body param of type object or array');
  if (bodyMode === "text" && (bodyParams.length !== 1 || !["string", "array"].includes(bodyParams[0].type))) fail('bodyMode "text" needs exactly one body param of type string (sent as is) or array (sent as NDJSON)');
  if (operation.formArrays !== undefined && (bodyMode !== "form" || !FORM_ARRAY_STYLES.includes(operation.formArrays))) fail(`formArrays is only for bodyMode "form": one of ${FORM_ARRAY_STYLES.join(", ")}`);
  if (bodyMode === "file" && (bodyParams.length !== 1 || bodyParams[0].file !== true)) fail('bodyMode "file" needs exactly one body param, with `file: true` (the file is the whole body)');
  if (operation.contentType !== undefined && (!["json", "raw", "text", "file"].includes(bodyMode) || !/^[\w.+-]+\/[\w.+-]+(;.*)?$/.test(operation.contentType))) {
    fail('`contentType` must be a media type and is only for bodyMode "json", "raw", "text" or "file"');
  }
  validateFileSettings(operation, "multipart", bodyMode, fail);
  validateFileSettings(operation, "fileBody", bodyMode, fail);
}

// `multipart` (bodyMode "multipart") and `fileBody` (bodyMode "file") hold the same file input settings.
function validateFileSettings(operation, settingsKey, bodyMode, fail) {
  const settings = operation[settingsKey];
  if (settings === undefined) return;
  const settingsBodyMode = settingsKey === "fileBody" ? "file" : "multipart";
  if (bodyMode !== settingsBodyMode) fail(`\`${settingsKey}\` settings need bodyMode "${settingsBodyMode}"`);
  rejectUnknownKeys(settings, FILE_SETTINGS_KEYS, settingsKey, fail);
  if (settings.fileDirEnv !== undefined) checkEnvName(settings.fileDirEnv, `${settingsKey}.fileDirEnv`, fail);
  if (settings.maxFileBytes !== undefined && !(Number.isInteger(settings.maxFileBytes) && settings.maxFileBytes > 0)) fail(`${settingsKey}.maxFileBytes must be a positive integer`);
}

function validateConstants(operation, fail) {
  const constants = operation.constants;
  if (constants === undefined) return;
  rejectUnknownKeys(constants, CONSTANT_KEYS, "constants", fail);
  const params = Object.entries(operation.params ?? {});
  const wireNamesIn = (location) => new Set(params.filter(([, paramSpec]) => paramSpec.in === location).map(([paramName, paramSpec]) => (paramSpec.wireName ?? paramName).toLowerCase()));
  for (const [constantLocation, paramLocation] of [["query", "query"], ["body", "body"], ["headers", "header"]]) {
    const paramWireNames = wireNamesIn(paramLocation);
    for (const constantName of Object.keys(constants[constantLocation] ?? {})) {
      if (paramWireNames.has(constantName.toLowerCase())) fail(`constant ${constantLocation} \`${constantName}\` collides with a param of the same name`);
      if (constantLocation === "headers") checkHeaderName(constantName, "constants.headers:", fail);
      if (constantLocation === "body" && findForbiddenSegments(constantName).length > 0) fail(`constant body \`${constantName}\` has a forbidden segment`);
    }
  }
  if (constants.body && ["raw", "text", "file"].includes(operation.bodyMode)) fail(`constant body values cannot be combined with bodyMode "${operation.bodyMode}"`);
}

// --- response and pagination ------------------------------------------------------------------------

function validateResponse(operation, method, fail) {
  const response = operation.response;
  if (response === undefined) return;
  rejectUnknownKeys(response, RESPONSE_KEYS, "response", fail);
  const styles = paginationStyles(response);
  if (styles.length > 1) fail("response: declare only one pagination style (cursorPath, nextLinkHeader, nextUrlPath, lastItemCursor, pagePagination or offsetPagination)");
  if (response.cursorPath !== undefined) requireText(response.cursorParam, "response.cursorParam (the API's cursor parameter name)", fail);
  validatePaginationShapes(response, fail);
  if (styles.length > 0) validatePaginationPlacement(operation, method, response, fail);
  validateBinaryResponse(operation, response, styles, fail);
}

function validatePaginationShapes(response, fail) {
  if (response.pagePagination) {
    rejectUnknownKeys(response.pagePagination, PAGE_PAGINATION_KEYS, "pagePagination", fail);
    requireText(response.pagePagination.pageParam, "pagePagination.pageParam", fail);
  }
  if (response.offsetPagination) {
    rejectUnknownKeys(response.offsetPagination, OFFSET_PAGINATION_KEYS, "offsetPagination", fail);
    requireText(response.offsetPagination.offsetParam, "offsetPagination.offsetParam", fail);
  }
  if (response.lastItemCursor) {
    rejectUnknownKeys(response.lastItemCursor, LAST_ITEM_KEYS, "response.lastItemCursor", fail);
    requireText(response.lastItemCursor.itemIdPath, "response.lastItemCursor.itemIdPath", fail);
    requireText(response.lastItemCursor.param, "response.lastItemCursor.param", fail);
  }
  if (response.nextUrlPath !== undefined) requireText(response.nextUrlPath, "response.nextUrlPath", fail);
  if (response.paramsIn !== undefined && !["query", "body"].includes(response.paramsIn)) fail('response.paramsIn must be "query" or "body"');
}

function validatePaginationPlacement(operation, method, response, fail) {
  const paramsIn = response.paramsIn ?? (READ_METHODS.has(method) ? "query" : "body");
  if (paramsIn === "body" && READ_METHODS.has(method)) fail(`response.paramsIn: "body" cannot be used with ${method}, which sends no body`);
  const bodyMode = operation.bodyMode ?? "json";
  if (paramsIn === "body" && ["raw", "text", "multipart", "file"].includes(bodyMode)) fail(`bodyMode "${bodyMode}" cannot carry pagination params in the body; set response.paramsIn: "query"`);
  const { limitWireName, cursorWireName } = describePaginationWireNames(response);
  const paramLocation = paramsIn === "body" ? "body" : "query";
  for (const [paramName, paramSpec] of Object.entries(operation.params ?? {})) {
    const wireName = paramSpec.wireName ?? paramName;
    if (paramSpec.in === paramLocation && [limitWireName, cursorWireName].includes(wireName)) fail(`param \`${paramName}\` sends \`${wireName}\`, which pagination also sends`);
  }
}

function validateBinaryResponse(operation, response, styles, fail) {
  if (response.binary === undefined) return;
  rejectUnknownKeys(response.binary, BINARY_KEYS, "response.binary", fail);
  checkEnvName(response.binary.envDir, "response.binary.envDir", fail);
  if (styles.length > 0 || response.dataPath !== undefined || operation.job || operation.download) {
    fail("response.binary saves the whole body to a file and cannot be combined with dataPath, pagination, job or download");
  }
}

// --- jobs and downloads ----------------------------------------------------------------------------

function validateJob(spec, operation, fail) {
  const job = operation.job;
  if (job === undefined) return;
  rejectUnknownKeys(job, JOB_KEYS, "job", fail);
  if ((operation.write ?? "read") === "read") fail('a job is started by a write: set `write: "unsafe"` (or "idempotent")');
  requireText(job.idPath, "job.idPath", fail);
  requireText(job.statusPath, "job.statusPath", fail);
  if (!Array.isArray(job.doneValues) || job.doneValues.length === 0) fail("job.doneValues must list the finished status values");
  validateJobRequest(job.poll, "job.poll", POLL_KEYS, operation, fail);
  if (job.result !== undefined) validateJobRequest(job.result, "job.result", JOB_RESULT_KEYS, operation, fail);
  if (job.allowedHosts !== undefined && (!Array.isArray(job.allowedHosts) || !job.allowedHosts.every((host) => typeof host === "string" && HOST_NAME.test(host)))) {
    fail('job.allowedHosts must list host names, e.g. ["queue.fal.run"]');
  }
  validateJobBudget(spec, job, fail);
}

function validateJobRequest(jobRequest, label, allowedKeys, operation, fail) {
  if (!jobRequest || typeof jobRequest !== "object") fail(`${label} is required`);
  rejectUnknownKeys(jobRequest, allowedKeys, label, fail);
  if ((jobRequest.path === undefined) === (jobRequest.urlPath === undefined)) fail(`${label} needs exactly one of \`path\` (a template) or \`urlPath\` (where the create response puts the URL)`);
  if (jobRequest.urlPath !== undefined) requireText(jobRequest.urlPath, `${label}.urlPath`, fail);
  if (jobRequest.path !== undefined && (typeof jobRequest.path !== "string" || !jobRequest.path.startsWith("/"))) fail(`${label}.path must start with "/"`);
  const requestMethod = (jobRequest.method ?? "GET").toUpperCase();
  if (!HTTP_METHODS.includes(requestMethod)) fail(`${label}.method \`${jobRequest.method}\` is unknown`);
  const params = operation.params ?? {};
  for (const { name: placeholderName } of listPlaceholders(jobRequest.path ?? "")) {
    if (placeholderName === "id" && params.id?.in === "path") fail("path param `id` collides with the job's {id} placeholder; rename the param");
    if (placeholderName !== "id" && params[placeholderName]?.in !== "path") fail(`job poll path placeholder {${placeholderName}} must be {id} or a path param`);
  }
}

function validateJobBudget(spec, job, fail) {
  const { hostTimeoutMs, jobBudgetCapMs } = describeTimeBudgets(spec.limits);
  if (jobBudgetCapMs < MIN_JOB_BUDGET_MS) fail(`limits.timeout_ms ${hostTimeoutMs} leaves no time to wait for a job (it needs at least ${MIN_JOB_BUDGET_MS + 15000}); raise limits.timeout_ms`);
  if (job.timeoutMs !== undefined && (!Number.isInteger(job.timeoutMs) || job.timeoutMs <= 0)) fail("job.timeoutMs must be a positive integer");
  if (job.timeoutMs > jobBudgetCapMs) fail(`job.timeoutMs ${job.timeoutMs} does not fit in limits.timeout_ms ${hostTimeoutMs} minus 15 s; raise limits.timeout_ms`);
}

function validateDownload(operation, fail) {
  if (operation.download === undefined) return;
  const saveTo = operation.download?.saveTo;
  if (!saveTo || typeof saveTo !== "object") fail("download.saveTo is required");
  rejectUnknownKeys(saveTo, SAVE_TO_KEYS, "download.saveTo", fail);
  checkEnvName(saveTo.envDir, "download.saveTo.envDir", fail);
  const hasPaths = (paths) => Array.isArray(paths) && paths.length > 0;
  if (!hasPaths(saveTo.urlPaths) && !hasPaths(saveTo.base64Paths)) fail('download.saveTo needs urlPaths or base64Paths, e.g. urlPaths: ["data[].url"]');
  if (saveTo.maxFiles !== undefined && !(Number.isInteger(saveTo.maxFiles) && saveTo.maxFiles > 0 && saveTo.maxFiles <= MAX_DOWNLOAD_FILES)) fail(`download.saveTo.maxFiles must be 1..${MAX_DOWNLOAD_FILES}`);
}
