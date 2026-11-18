/**
 * Load-time validation of a declarative REST plugin spec (see rest-plugin.mjs).
 *
 * A spec is code written by a plugin author, so problems throw a plain Error that names the plugin, the operation
 * and the field: unknown keys (typos such as `requried`), unknown param locations or types, path placeholders
 * without a path param, missing write classes, ambiguous pagination, malformed jobs and downloads.
 */

export const PARAM_LOCATIONS = ["path", "query", "body", "header"];
export const PARAM_TYPES = ["string", "integer", "number", "boolean", "array", "object"];
export const WRITE_CLASSES = ["read", "idempotent", "unsafe"];
export const BODY_MODES = ["json", "form", "raw"];
export const ERROR_KINDS = ["invalid_input", "auth_error", "permission_denied", "not_found", "rate_limited", "api_error", "network_error", "timeout"];
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
export const RESERVED_PARAM_NAMES = new Set(["access_token"]);
export const PAGINATION_PARAM_NAMES = ["limit", "cursor"];
export const JOB_WAIT_PARAM = "wait";
export const TOOL_POLICY_PATTERN = /^optIn:([A-Z][A-Z0-9_]*)$/;
const READ_METHODS = new Set(["GET", "HEAD"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

const SPEC_KEYS = ["name", "version", "description", "apiName", "baseUrl", "auth", "extraEnv", "limits", "defaultHeaders", "errors", "apiRequest", "timeoutMs", "maxRetries", "operations"];
const AUTH_KEYS = {
  none: ["type"],
  bearer: ["type", "env"],
  header: ["type", "env", "header", "prefix"],
  query: ["type", "env", "param"],
  basic: ["type", "userEnv", "passwordEnv", "tokenEnv", "user", "password"],
  custom: ["type", "env", "authorize"],
};
const ERROR_KEYS = ["messagePath", "codePath", "retryAfterPath", "retryAfterUnit", "kindByCode", "kindByStatus", "retryableCodes", "okPath", "okValue", "errorPath"];
const OPERATION_KEYS = ["name", "title", "description", "method", "path", "params", "bodyMode", "write", "checkHint", "nodeOnly", "toolPolicy", "response", "job", "download", "timeoutMs"];
const PARAM_KEYS = ["in", "type", "required", "description", "enum", "min", "max", "default", "wireName", "items", "maxItems", "minLength"];
const RESPONSE_KEYS = ["dataPath", "cursorPath", "cursorParam", "limitParam", "hasMorePath", "nextLinkHeader", "pagePagination", "offsetPagination", "maxLimit", "defaultLimit", "paramsIn"];
const PAGE_PAGINATION_KEYS = ["pageParam", "sizeParam", "firstPage", "totalPagesPath"];
const OFFSET_PAGINATION_KEYS = ["offsetParam", "limitParam", "totalPath"];
const JOB_KEYS = ["idPath", "poll", "statusPath", "doneValues", "failedValues", "errorPath", "resultPath", "intervalMs", "timeoutMs"];
const POLL_KEYS = ["method", "path", "params"];
const SAVE_TO_KEYS = ["urlPaths", "envDir", "maxBytes"];

/**
 * Validates a REST plugin spec, throwing on the first problem.
 *
 * @param spec - Spec passed to defineRestPlugin (object)
 * @returns Nothing; the spec is valid when this returns
 * @throws Error - "<plugin>: <where>: <problem>" for the first problem found
 *
 * @example
 * validateRestSpec({ name: "x", ... }); // throws 'x: operation `get`: path placeholder {id} has no `in: "path"` param'
 */
export function validateRestSpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("rest plugin: the spec must be an object");
  const fail = (problem) => {
    throw new Error(`${typeof spec.name === "string" && spec.name ? spec.name : "rest plugin"}: ${problem}`);
  };
  validatePluginBasics(spec, fail);
  validateAuth(spec.auth, fail);
  validateErrors(spec.errors, fail);
  validateOperations(spec, fail);
}

function validatePluginBasics(spec, fail) {
  rejectUnknownKeys(spec, SPEC_KEYS, "spec", fail);
  if (typeof spec.name !== "string" || spec.name === "") fail("`name` is required");
  if (!KEBAB_CASE.test(spec.name)) fail(`\`name\` "${spec.name}" must be kebab-case`);
  if (typeof spec.version !== "string" || spec.version === "") fail("`version` is required");
  requireText(spec.description, "`description`", fail);
  if (typeof spec.baseUrl !== "function") checkBaseUrl(spec.baseUrl, fail);
  for (const envName of spec.extraEnv ?? []) checkEnvName(envName, "extraEnv", fail);
}

/**
 * Checks a base URL: https, or http on localhost only (local servers such as Ollama).
 *
 * @param baseUrl - Candidate URL (string)
 * @param fail - `(problem) => never` (function)
 * @returns Nothing
 */
export function checkBaseUrl(baseUrl, fail) {
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return fail(`\`baseUrl\` ${JSON.stringify(baseUrl)} is not a valid URL`);
  }
  const isLocalHttp = parsedUrl.protocol === "http:" && LOCAL_HOSTS.has(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !isLocalHttp) fail(`\`baseUrl\` ${baseUrl} must use https (http only on localhost)`);
}

function validateAuth(auth, fail) {
  if (!auth || typeof auth !== "object") fail("`auth` is required, e.g. {type: \"bearer\", env: \"API_TOKEN\"} or {type: \"none\"}");
  const allowedKeys = AUTH_KEYS[auth.type];
  if (!allowedKeys) fail(`auth type \`${auth.type}\` is unknown; use one of ${Object.keys(AUTH_KEYS).join(", ")}`);
  rejectUnknownKeys(auth, allowedKeys, "auth", fail);
  const authCheckers = {
    bearer: () => checkEnvName(auth.env, "auth.env", fail),
    header: () => (checkEnvName(auth.env, "auth.env", fail), requireText(auth.header, "auth.header", fail)),
    query: () => (checkEnvName(auth.env, "auth.env", fail), requireText(auth.param, "auth.param", fail)),
    basic: () => validateBasicAuth(auth, fail),
    custom: () => validateCustomAuth(auth, fail),
  };
  authCheckers[auth.type]?.();
}

function validateBasicAuth(auth, fail) {
  const hasEnvPair = auth.userEnv !== undefined || auth.passwordEnv !== undefined;
  if (hasEnvPair) {
    checkEnvName(auth.userEnv, "auth.userEnv", fail);
    return checkEnvName(auth.passwordEnv, "auth.passwordEnv", fail);
  }
  if (auth.tokenEnv === undefined) fail("basic auth needs {userEnv, passwordEnv} or {tokenEnv, user} or {tokenEnv, password}");
  checkEnvName(auth.tokenEnv, "auth.tokenEnv", fail);
  if ((typeof auth.user === "string") === (typeof auth.password === "string")) fail("basic auth with tokenEnv needs exactly one of `user` or `password`");
}

function validateCustomAuth(auth, fail) {
  if (typeof auth.authorize !== "function") fail("auth.authorize must be a function `({headers, query, credential, environment}) => secrets[]`");
  if (auth.env !== undefined) checkEnvName(auth.env, "auth.env", fail);
}

function validateErrors(errors, fail) {
  if (errors === undefined) return;
  rejectUnknownKeys(errors, ERROR_KEYS, "errors", fail);
  for (const kind of [...Object.values(errors.kindByCode ?? {}), ...Object.values(errors.kindByStatus ?? {})]) {
    if (!ERROR_KINDS.includes(kind)) fail(`errors: kind \`${kind}\` is unknown; use one of ${ERROR_KINDS.join(", ")}`);
  }
  if (errors.retryAfterUnit !== undefined && !["seconds", "milliseconds"].includes(errors.retryAfterUnit)) fail('errors.retryAfterUnit must be "seconds" or "milliseconds"');
}

function validateOperations(spec, fail) {
  if (!Array.isArray(spec.operations) || spec.operations.length === 0) fail("the spec needs at least one operation");
  const seenNames = new Set();
  for (const operation of spec.operations) {
    const operationName = operation?.name;
    if (seenNames.has(operationName)) fail(`duplicate operation \`${operationName}\``);
    seenNames.add(operationName);
    if (operationName === "api_request" && spec.apiRequest !== false) fail("operation `api_request` is generated; set `apiRequest: false` to define your own");
    validateOperation(spec, operation, (problem) => fail(`operation \`${operationName}\`: ${problem}`));
  }
}

function validateOperation(spec, operation, fail) {
  rejectUnknownKeys(operation, OPERATION_KEYS, "operation", fail);
  if (typeof operation.name !== "string" || !SNAKE_CASE.test(operation.name)) fail("`name` must be snake_case");
  requireText(operation.title, "`title`", fail);
  requireText(operation.description, "`description`", fail);
  const method = (operation.method ?? "GET").toUpperCase();
  if (!HTTP_METHODS.includes(method)) fail(`method \`${operation.method}\` is unknown; use one of ${HTTP_METHODS.join(", ")}`);
  if (typeof operation.path !== "string" || !operation.path.startsWith("/")) fail('`path` must start with "/"');
  validateWriteClass(operation, method, fail);
  validateParams(spec, operation, method, fail);
  validatePathPlaceholders(operation, fail);
  validateBodyMode(operation, fail);
  if (operation.toolPolicy !== undefined && !TOOL_POLICY_PATTERN.test(operation.toolPolicy)) fail('`toolPolicy` must be "optIn:<ENV_NAME>"');
  validateResponse(operation, fail);
  validateJob(operation, fail);
  validateDownload(operation, fail);
}

function validateWriteClass(operation, method, fail) {
  if (operation.write === undefined) {
    if (!READ_METHODS.has(method)) fail(`${method} operations must declare \`write\`: "idempotent" (safe to repeat) or "unsafe" (creates or sends)`);
    return;
  }
  if (!WRITE_CLASSES.includes(operation.write)) fail(`write class \`${operation.write}\` is unknown; use one of ${WRITE_CLASSES.join(", ")}`);
  if (operation.write === "read" && !READ_METHODS.has(method)) fail('`write: "read"` is only for GET/HEAD; a POST that only reads is "idempotent"');
}

function validateParams(spec, operation, method, fail) {
  const params = operation.params ?? {};
  for (const [paramName, paramSpec] of Object.entries(params)) {
    const failParam = (problem) => fail(`param \`${paramName}\`: ${problem}`);
    if (RESERVED_PARAM_NAMES.has(paramName)) failParam("`access_token` is reserved for the node credential override");
    rejectUnknownKeys(paramSpec, PARAM_KEYS, "param", failParam);
    if (!PARAM_LOCATIONS.includes(paramSpec.in)) failParam(`\`in\` must be one of ${PARAM_LOCATIONS.join(", ")}`);
    if (!PARAM_TYPES.includes(paramSpec.type)) failParam(`type \`${paramSpec.type}\` is unknown; use one of ${PARAM_TYPES.join(", ")}`);
    if (paramSpec.wireName !== undefined) requireText(paramSpec.wireName, "`wireName`", failParam);
    if (paramSpec.in === "path" && paramSpec.required !== true) fail(`path param \`${paramName}\` must be required`);
    if (paramSpec.in === "body" && READ_METHODS.has(method)) fail(`${method} cannot have body params (\`${paramName}\`); use \`in: "query"\``);
    checkCredentialCollision(spec.auth, paramName, paramSpec, failParam);
  }
  if (hasPagination(operation.response)) checkReservedNames(params, PAGINATION_PARAM_NAMES, fail);
  if (operation.job) checkReservedNames(params, [JOB_WAIT_PARAM], fail);
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

function checkReservedNames(params, reservedNames, fail) {
  for (const reservedName of reservedNames) {
    if (Object.hasOwn(params, reservedName)) fail(`param \`${reservedName}\` is reserved: it is generated for this operation`);
  }
}

/**
 * Lists the `{name}` placeholders in a path template.
 *
 * @param pathTemplate - e.g. "/repos/{owner}/{repo}" (string)
 * @returns Placeholder names (string[])
 */
export function listPlaceholders(pathTemplate) {
  return [...pathTemplate.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
}

function validatePathPlaceholders(operation, fail) {
  const params = operation.params ?? {};
  const placeholders = listPlaceholders(operation.path);
  for (const placeholder of placeholders) {
    if (params[placeholder]?.in !== "path") fail(`path placeholder {${placeholder}} has no \`in: "path"\` param`);
  }
  for (const [paramName, paramSpec] of Object.entries(params)) {
    if (paramSpec.in === "path" && !placeholders.includes(paramName)) fail(`path param \`${paramName}\` is not used in path ${operation.path}`);
  }
}

function validateBodyMode(operation, fail) {
  if (operation.bodyMode === undefined) return;
  if (!BODY_MODES.includes(operation.bodyMode)) fail(`bodyMode \`${operation.bodyMode}\` is unknown; use one of ${BODY_MODES.join(", ")}`);
  const bodyParams = Object.values(operation.params ?? {}).filter((paramSpec) => paramSpec.in === "body");
  if (operation.bodyMode === "raw" && (bodyParams.length !== 1 || !["object", "array"].includes(bodyParams[0].type))) {
    fail('bodyMode "raw" needs exactly one body param of type object or array');
  }
}

/**
 * Whether a response spec declares any pagination style.
 *
 * @param response - Operation `response` spec (object, optional)
 * @returns True when limit/cursor are generated (boolean)
 */
export function hasPagination(response) {
  return paginationStyles(response).length > 0;
}

function paginationStyles(response) {
  if (!response) return [];
  const styles = [["cursor", response.cursorPath], ["link", response.nextLinkHeader], ["page", response.pagePagination], ["offset", response.offsetPagination]];
  return styles.filter(([, declared]) => declared).map(([style]) => style);
}

function validateResponse(operation, fail) {
  const response = operation.response;
  if (response === undefined) return;
  rejectUnknownKeys(response, RESPONSE_KEYS, "response", fail);
  if (paginationStyles(response).length > 1) fail("response: declare only one pagination style (cursorPath, nextLinkHeader, pagePagination or offsetPagination)");
  if (response.cursorPath !== undefined) requireText(response.cursorParam, "response.cursorParam (the API's cursor parameter name)", fail);
  if (response.pagePagination) {
    rejectUnknownKeys(response.pagePagination, PAGE_PAGINATION_KEYS, "pagePagination", fail);
    requireText(response.pagePagination.pageParam, "pagePagination.pageParam", fail);
  }
  if (response.offsetPagination) {
    rejectUnknownKeys(response.offsetPagination, OFFSET_PAGINATION_KEYS, "offsetPagination", fail);
    requireText(response.offsetPagination.offsetParam, "offsetPagination.offsetParam", fail);
  }
  if (response.paramsIn !== undefined && !["query", "body"].includes(response.paramsIn)) fail('response.paramsIn must be "query" or "body"');
}

function validateJob(operation, fail) {
  const job = operation.job;
  if (job === undefined) return;
  rejectUnknownKeys(job, JOB_KEYS, "job", fail);
  if ((operation.write ?? "read") === "read") fail('a job is started by a write: set `write: "unsafe"` (or "idempotent")');
  requireText(job.idPath, "job.idPath", fail);
  requireText(job.statusPath, "job.statusPath", fail);
  if (!Array.isArray(job.doneValues) || job.doneValues.length === 0) fail("job.doneValues must list the finished status values");
  if (!job.poll || typeof job.poll !== "object") fail("job.poll is required");
  rejectUnknownKeys(job.poll, POLL_KEYS, "job.poll", fail);
  if (typeof job.poll.path !== "string" || !job.poll.path.startsWith("/")) fail('job.poll.path must start with "/"');
  const pollMethod = (job.poll.method ?? "GET").toUpperCase();
  if (!HTTP_METHODS.includes(pollMethod)) fail(`job.poll.method \`${job.poll.method}\` is unknown`);
  const params = operation.params ?? {};
  for (const placeholder of listPlaceholders(job.poll.path)) {
    if (placeholder !== "id" && params[placeholder]?.in !== "path") fail(`job poll path placeholder {${placeholder}} must be {id} or a path param`);
  }
}

function validateDownload(operation, fail) {
  if (operation.download === undefined) return;
  const saveTo = operation.download?.saveTo;
  if (!saveTo || typeof saveTo !== "object") fail("download.saveTo is required");
  rejectUnknownKeys(saveTo, SAVE_TO_KEYS, "download.saveTo", fail);
  checkEnvName(saveTo.envDir, "download.saveTo.envDir", fail);
  if (!Array.isArray(saveTo.urlPaths) || saveTo.urlPaths.length === 0) fail("download.saveTo.urlPaths must list where the result URLs are, e.g. [\"data[].url\"]");
}

function rejectUnknownKeys(candidate, allowedKeys, where, fail) {
  if (!candidate || typeof candidate !== "object") fail(`${where} must be an object`);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.includes(key)) fail(`${where}: unknown key \`${key}\` (allowed: ${allowedKeys.join(", ")})`);
  }
}

function requireText(value, label, fail) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
}

function checkEnvName(envName, label, fail) {
  if (typeof envName !== "string" || !ENV_NAME.test(envName)) fail(`${label} must be an UPPER_SNAKE_CASE environment variable name`);
}
