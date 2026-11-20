/**
 * Declarative REST plugins: `defineRestPlugin(spec)` turns a data-only description of a REST API into a normal
 * plugin definition for operations.mjs, so the runner, `npm run sync`, the manifest and OPERATIONS.md work
 * unchanged. The guide with every field and a full annotated example is docs/declarative-plugins.md.
 *
 * Safety semantics:
 *   - every request is sent with redactResponse, and cursors pass through redact: a credential echoed by the API
 *     never reaches data, next_cursor, job results or errors.
 *   - write "read" and "idempotent" requests are retried after 5xx and network failures; "unsafe" ones never are
 *     (unless an Idempotency-Key makes them safe), and their errors say the outcome is unknown plus `checkHint`.
 *   - path params are encoded segment by segment; next-page URLs must stay under the base URL.
 *   - `toolUserToken` lets `<PLUGIN>_TOOL_TOKEN_SOURCE=context` take tool tokens from the call context
 *     (see tool-user-token.mjs); the env credential, including OAuth envs, is then hidden from tools.
 *   - `toolPolicy: "optIn:<ENV>"` refuses tool calls unless <ENV>=1; `nodeOnly` hides the tool entirely;
 *     `api_request` is GET-only for tools and cannot reach the paths of such GET operations.
 *   - jobs and downloads share one deadline that starts with the call and ends before the host's timeout.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createApiClient } from "./api-client.mjs";
import { createApiRequestOperation } from "./api-request-operation.mjs";
import { PluginError } from "./graphrt-plugin.mjs";
import { classifyTransferError, saveResponseToFile } from "./public-https-fetch.mjs";
import { createAuthHooks, createCredentialResolver, describeAuthEnv } from "./rest-auth.mjs";
import { listOAuthEnv } from "./rest-oauth.mjs";
import { listResultUrls, saveDownloads, DEFAULT_MAX_DOWNLOAD_BYTES } from "./rest-downloads.mjs";
import { createBodyErrorDetector, createErrorParser } from "./rest-errors.mjs";
import { describeJobError, readJobId, resolveJobBudgetMs, waitForJob } from "./rest-job.mjs";
import { buildRestRequest, hasFileParams } from "./rest-request.mjs";
import { DEFAULT_TOOL_OUTPUT, shapeRestResponse, truncateForTool } from "./rest-response.mjs";
import { checkBaseUrl, DEFAULT_REQUEST_TIMEOUT_MS, describePaginationWireNames, describeTimeBudgets, JOB_WAIT_PARAM, paginationStyles, READ_METHODS, TOOL_POLICY_PATTERN } from "./rest-spec-helpers.mjs";
import { validateRestSpec } from "./rest-spec-validation.mjs";
import { createTransferBudget } from "./transfer-budget.mjs";

const UNKNOWN_OUTCOME_MARKER = "outcome unknown";

/**
 * Builds a plugin definition from a declarative REST spec, validating the spec first.
 *
 * @param spec - REST plugin spec (object, see docs/declarative-plugins.md)
 * @returns Plugin definition for operations.mjs, with the normalized spec as `restSpec` (object)
 * @throws Error - When the spec is invalid; the message names the plugin, operation and field
 *
 * @example
 * export const pluginDefinition = defineRestPlugin({
 *   name: "open-meteo", version: "0.1.0", description: "Weather forecasts",
 *   baseUrl: "https://api.open-meteo.com", auth: { type: "none" },
 *   operations: [{ name: "get_forecast", title: "Forecast", description: "Weather forecast", path: "/v1/forecast",
 *     params: { latitude: { in: "query", type: "number", required: true } } }],
 * });
 */
export function defineRestPlugin(spec) {
  validateRestSpec(spec);
  const restSpec = { ...spec, operations: spec.operations.map(normalizeOperation) };
  const settings = { spec, jobBudgetCapMs: describeTimeBudgets(spec.limits).jobBudgetCapMs };
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    ...describeCredentials(spec.auth),
    extraEnv: collectExtraEnv(restSpec),
    limits: spec.limits,
    ...describeToolUserToken(spec),
    createClient: (clientOptions) => createRestClient(spec, clientOptions),
    restSpec,
    operations: [...restSpec.operations.map((operation) => buildOperation(operation, settings)), ...buildApiRequest(restSpec)],
  };
}

function describeCredentials(auth) {
  if (auth.type === "none") return { tokenEnv: undefined, noCredentials: true };
  return { tokenEnv: describeAuthEnv(auth).tokenEnv, resolveAccessToken: createCredentialResolver(auth) };
}

// The auth's own secret envs (e.g. an OAuth refresh token) are hidden from tools in context mode too.
function describeToolUserToken(spec) {
  if (!spec.toolUserToken) return {};
  const authEnv = spec.auth.type === "oauth2" ? listOAuthEnv(spec.auth) : [];
  const credentialEnv = [...authEnv, ...(spec.toolUserToken.credentialEnv ?? [])];
  return { toolUserToken: { credentialEnv: [...new Set(credentialEnv)] } };
}

function collectExtraEnv(restSpec) {
  const operationEnv = restSpec.operations.flatMap((operation) => [
    operation.toolPolicy ? TOOL_POLICY_PATTERN.exec(operation.toolPolicy)[1] : undefined,
    operation.download?.saveTo.envDir,
    operation.response?.binary?.envDir,
    operation.multipart?.fileDirEnv,
    operation.fileBody?.fileDirEnv,
  ]);
  const envNames = [...describeAuthEnv(restSpec.auth).extraEnv, ...(restSpec.extraEnv ?? []), ...operationEnv].filter(Boolean);
  return [...new Set(envNames)];
}

function normalizeOperation(operation) {
  const method = (operation.method ?? "GET").toUpperCase();
  const [style] = paginationStyles(operation.response);
  return {
    ...operation,
    method,
    params: operation.params ?? {},
    bodyMode: operation.bodyMode ?? "json",
    write: operation.write ?? "read",
    pagination: style ? { style, paramsIn: operation.response.paramsIn ?? (READ_METHODS.has(method) ? "query" : "body") } : undefined,
  };
}

// --- clients ----------------------------------------------------------------------------------------

// The plugin's client; `clientFor(baseUrl)` gives one for another host of the API (same credential mode).
function createRestClient(spec, { accessToken, environment, fetchImpl, resolveHostAddresses }) {
  const downloadFetch = fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
  const authHooks = createAuthHooks(spec.auth, accessToken, environment, downloadFetch);
  const clientsByKey = new Map();
  const clientFor = (baseUrl, sendCredential = true) => {
    const cacheKey = `${sendCredential}\n${baseUrl}`;
    if (!clientsByKey.has(cacheKey)) {
      const apiClient = createApiClient({
        baseUrl,
        ...(sendCredential ? authHooks : {}),
        parseError: createErrorParser(spec.errors),
        detectBodyError: createBodyErrorDetector(spec.errors),
        defaultHeaders: spec.defaultHeaders,
        timeoutMs: spec.timeoutMs,
        maxRetries: spec.maxRetries,
        fetchImpl,
      });
      clientsByKey.set(cacheKey, { ...apiClient, baseUrl, fetchImpl: downloadFetch, resolveHostAddresses, environment, clientFor: (otherBaseUrl, otherSendCredential = true) => clientFor(otherBaseUrl, sendCredential && otherSendCredential) });
    }
    return clientsByKey.get(cacheKey);
  };
  return clientFor(resolveBaseUrl(spec.baseUrl, environment, spec.allowedHostSuffix));
}

/**
 * Resolves the base URL; a function receives the environment and may throw to reject bad env values.
 *
 * @param baseUrl - URL or `(environment) => string` (string | function)
 * @param environment - Environment variables (object)
 * @param allowedHostSuffix - Host suffix the result must have, e.g. ".atlassian.net" (string, optional)
 * @returns Base URL (string)
 * @throws PluginError kind `invalid_input` - When the function throws or returns a URL that is not allowed
 */
export function resolveBaseUrl(baseUrl, environment, allowedHostSuffix) {
  const failConfiguration = (problem) => {
    throw new PluginError(`Invalid API base URL configuration: ${problem}`, { kind: "invalid_input" });
  };
  if (typeof baseUrl !== "function") return baseUrl;
  let resolvedUrl;
  try {
    resolvedUrl = baseUrl(environment ?? {});
  } catch (configurationError) {
    failConfiguration(configurationError?.message ?? String(configurationError));
  }
  checkBaseUrl(resolvedUrl, failConfiguration, allowedHostSuffix);
  return resolvedUrl;
}

function selectClient(operation, context) {
  if (!operation.baseUrl) return context.client;
  return context.client.clientFor(resolveBaseUrl(operation.baseUrl, context.environment), operation.sendCredential !== false);
}

// --- operations -------------------------------------------------------------------------------------

function buildOperation(operation, settings) {
  return {
    name: operation.name,
    title: operation.title,
    description: describeOperation(operation),
    nodeOnly: operation.nodeOnly === true,
    parameters: buildParameterSchema(operation),
    run: async (context) => {
      const result = await runOperation(operation, context, settings);
      if (context.source !== "tool") return result;
      const toolOutput = operation.toolOutput ?? settings.spec.toolOutput ?? DEFAULT_TOOL_OUTPUT;
      return { ...result, data: truncateForTool(result.data, toolOutput) };
    },
  };
}

function describeOperation(operation) {
  if (!operation.toolPolicy) return operation.description;
  const envName = TOOL_POLICY_PATTERN.exec(operation.toolPolicy)[1];
  return `${operation.description} (as an agent tool only when ${envName}=1)`;
}

/**
 * Builds the JSON schema for an operation: its params plus generated `limit`/`cursor` and `wait`.
 *
 * @param operation - Normalized operation spec (object)
 * @returns Object schema with `properties` and `required` (object)
 */
export function buildParameterSchema(operation) {
  const properties = {};
  const required = [];
  for (const [paramName, paramSpec] of Object.entries(operation.params)) {
    properties[paramName] = toPropertySchema(paramSpec);
    if (paramSpec.required) required.push(paramName);
  }
  Object.assign(properties, buildPaginationProperties(operation), buildJobProperties(operation));
  return { type: "object", properties, required };
}

function toPropertySchema(paramSpec) {
  const fileNote = paramSpec.file ? " (an https URL, or an absolute path inside the plugin's upload directory)" : "";
  const schemaFields = {
    type: paramSpec.type,
    description: paramSpec.description || fileNote ? `${paramSpec.description ?? "File"}${fileNote}` : undefined,
    enum: paramSpec.enum,
    minimum: paramSpec.min,
    maximum: paramSpec.max,
    minLength: paramSpec.minLength,
    maxItems: paramSpec.maxItems,
    items: paramSpec.items,
    default: paramSpec.default,
  };
  return Object.fromEntries(Object.entries(schemaFields).filter(([, fieldValue]) => fieldValue !== undefined));
}

function buildPaginationProperties(operation) {
  if (!operation.pagination) return {};
  const response = operation.response;
  const { limitWireName } = describePaginationWireNames(response);
  const properties = { cursor: { type: "string", description: "next_cursor from the previous call, to get the next page" } };
  if (limitWireName) {
    const description = `Maximum items per page (sent as \`${limitWireName}\`)`;
    properties.limit = toPropertySchema({ type: "integer", min: 1, max: response.maxLimit, default: response.defaultLimit, description });
  }
  return properties;
}

function buildJobProperties(operation) {
  if (!operation.job) return {};
  const description = "Wait for the job to finish (default true); false returns the job id at once";
  return { [JOB_WAIT_PARAM]: { type: "boolean", default: true, description } };
}

async function runOperation(operation, context, settings) {
  assertToolPolicy(operation, context);
  const startedAt = Date.now();
  const client = selectClient(operation, context);
  const binaryDirectory = operation.response?.binary ? await prepareOutputDirectory(context.environment, operation.response.binary.envDir) : undefined;
  const idempotencyKey = resolveIdempotencyKey(operation, settings.spec);
  const transferBudget = hasFileParams(operation) ? createOperationTransferBudget(operation, settings, startedAt) : undefined;
  const requestContext = { baseUrl: client.baseUrl, environment: context.environment, fetchImpl: client.fetchImpl, resolveHostAddresses: client.resolveHostAddresses, signal: context.signal, idempotencyKey, transferBudget };
  const request = await buildRestRequest(operation, context.args, requestContext);
  const response = await sendRequest(operation, client, { ...request, signal: context.signal, redactResponse: true, rawResponse: Boolean(binaryDirectory) }, idempotencyKey);
  if (binaryDirectory) return { data: await saveBinaryResponse(operation, response, binaryDirectory, context.signal), next_cursor: null };
  const callContext = { ...context, client, startedAt, deadlineAt: startedAt + settings.jobBudgetCapMs };
  if (operation.job) return { data: await runJob(operation, response.body, callContext, settings), next_cursor: null };
  const shapedResult = shapeRestResponse(operation, response, context.args);
  if (!operation.download) return shapedResult;
  const { result, savedFiles } = await saveDownloads({ operation, result: shapedResult.data, client, environment: context.environment, signal: context.signal, deadlineAt: callContext.deadlineAt });
  return { data: { result, saved_files: savedFiles }, next_cursor: shapedResult.next_cursor };
}

// File inputs and the request share the call's budget (host timeout minus 10 s); the request needs minRequestMs.
function createOperationTransferBudget(operation, settings, startedAt) {
  const requestTimeoutMs = operation.timeoutMs ?? settings.spec.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const { requestTimeoutCapMs } = describeTimeBudgets(settings.spec.limits);
  return createTransferBudget({ totalMs: requestTimeoutCapMs, minRequestMs: operation.minRequestMs ?? requestTimeoutMs, maxRequestMs: requestTimeoutMs, startedAt });
}

function assertToolPolicy(operation, { source, environment }) {
  if (!operation.toolPolicy || source !== "tool") return;
  const envName = TOOL_POLICY_PATTERN.exec(operation.toolPolicy)[1];
  if (environment?.[envName] === "1") return;
  throw new PluginError(`\`${operation.name}\` is disabled for agent tools; set ${envName}=1 to allow it, or use a workflow node`, {
    kind: "permission_denied",
  });
}

function resolveIdempotencyKey(operation, spec) {
  const header = operation.idempotencyKeyHeader ?? spec.idempotencyKeyHeader;
  if (!header || operation.write !== "unsafe" || READ_METHODS.has(operation.method)) return undefined;
  return { header, value: randomUUID() };
}

async function sendRequest(operation, client, request, idempotencyKey) {
  try {
    return await client.requestWithHeaders(request);
  } catch (requestError) {
    throw describeWriteOutcome(operation, requestError, idempotencyKey);
  }
}

// A keyed write is retried with the same key; once retries run out, a new call would get a new key, so the
// outcome is unknown again.
function describeWriteOutcome(operation, requestError, idempotencyKey) {
  if (!(requestError instanceof PluginError)) return requestError;
  const hint = operation.checkHint ? `. To check: ${operation.checkHint}` : "";
  const keyedFailure = idempotencyKey && (requestError.kind === "network_error" || /^API error 5\d\d/.test(requestError.message));
  if (keyedFailure) {
    const note = ` (outcome unknown: the write may have been applied; check before retrying; ${idempotencyKey.header} ${idempotencyKey.value})`;
    return new PluginError(`${requestError.message}${note}${hint}`, { kind: requestError.kind, retryable: false });
  }
  if (!requestError.message.includes(UNKNOWN_OUTCOME_MARKER) || !hint) return requestError;
  return new PluginError(`${requestError.message}${hint}`, { kind: requestError.kind, retryable: false });
}

async function runJob(operation, createBody, callContext, settings) {
  const job = operation.job;
  const jobId = readJobId(job, createBody);
  if (callContext.args.wait === false) return { job_id: jobId, response: createBody };
  const deadlineAt = callContext.startedAt + resolveJobBudgetMs(job, callContext.environment, settings.jobBudgetCapMs);
  const jobLinks = {};
  try {
    const jobResult = await waitForJob({ operation, client: callContext.client, args: callContext.args, jobId, createBody, environment: callContext.environment, signal: callContext.signal, deadlineAt, jobLinks });
    if (!operation.download) return jobResult;
    jobLinks.files = listResultUrls(operation.download.saveTo, jobResult.result);
    const { result, savedFiles } = await saveDownloads({ operation, result: jobResult.result, client: callContext.client, environment: callContext.environment, signal: callContext.signal, deadlineAt });
    return { ...jobResult, result, saved_files: savedFiles };
  } catch (jobError) {
    throw describeJobError(jobError, jobId, jobLinks);
  }
}

async function prepareOutputDirectory(environment, envName) {
  const directory = environment?.[envName]?.trim();
  if (!directory || !isAbsolute(directory)) {
    throw new PluginError(`This operation saves the response to a file: set ${envName} to an absolute directory path`, { kind: "invalid_input" });
  }
  await mkdir(directory, { recursive: true });
  return directory;
}

async function saveBinaryResponse(operation, rawResult, directory, signal) {
  const fileBaseName = `${operation.name}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const maxBytes = operation.response.binary.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  try {
    return await saveResponseToFile(rawResult.response, { directory, fileBaseName, maxBytes, label: operation.name });
  } catch (saveError) {
    throw classifyTransferError(saveError, signal);
  }
}

// --- api_request ---------------------------------------------------------------------------------------

function buildApiRequest(restSpec) {
  if (restSpec.apiRequest === false) return [];
  const apiRequestOptions = typeof restSpec.apiRequest === "object" ? restSpec.apiRequest : {};
  const firstReadPath = restSpec.operations.find((operation) => !operation.path.includes("{") && READ_METHODS.has(operation.method))?.path;
  const apiRequestOperation = createApiRequestOperation({
    apiName: apiRequestOptions.apiName ?? restSpec.apiName ?? restSpec.name,
    examplePath: apiRequestOptions.examplePath ?? firstReadPath ?? "/",
  });
  const protectedPaths = listProtectedPaths(restSpec.operations);
  return [{ ...apiRequestOperation, run: (context) => (assertApiRequestPathAllowed(context, protectedPaths), apiRequestOperation.run(context)) }];
}

// GET operations an agent may not call directly must not be reachable through api_request either.
function listProtectedPaths(operations) {
  return operations
    .filter((operation) => !operation.baseUrl && READ_METHODS.has(operation.method) && (operation.nodeOnly || operation.toolPolicy))
    .map((operation) => ({
      operationName: operation.name,
      pathPattern: templateToPattern(operation.path),
      optInEnv: operation.nodeOnly ? undefined : TOOL_POLICY_PATTERN.exec(operation.toolPolicy)[1],
    }));
}

function templateToPattern(pathTemplate) {
  const escapedParts = pathTemplate.split(/(\{\+?[^{}]+\})/).map((part) => {
    if (part.startsWith("{+")) return ".+";
    if (part.startsWith("{")) return "[^/]+";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${escapedParts.join("").replace(/\/$/, "")}/?$`, "i");
}

function assertApiRequestPathAllowed({ source, args, environment }, protectedPaths) {
  if (source !== "tool" || typeof args?.path !== "string") return;
  const pathname = normalizeToolPathname(args.path.split(/[?#]/)[0]);
  const blocked = protectedPaths.find((protectedPath) => protectedPath.pathPattern.test(pathname) && !(protectedPath.optInEnv && environment?.[protectedPath.optInEnv] === "1"));
  if (!blocked) return;
  throw new PluginError(`api_request cannot reach the path of \`${blocked.operationName}\` as an agent tool; use that operation or a workflow node`, { kind: "permission_denied" });
}

const MAX_DECODE_ROUNDS = 4;

// Decoded until stable (a server may decode twice) and with repeated slashes collapsed, so "%252F" and "//"
// cannot hide a protected path. Comparing the decoded form only ever blocks more, never less.
function normalizeToolPathname(pathname) {
  let decoded = pathname;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const next = decodePathnameOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(/[\\/]+/g, "/");
}

function decodePathnameOnce(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
