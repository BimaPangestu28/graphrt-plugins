/**
 * Declarative REST plugins: `defineRestPlugin(spec)` turns a data-only description of a REST API into a normal
 * plugin definition for operations.mjs, so the runner, `npm run sync`, the manifest and OPERATIONS.md work
 * unchanged. The guide with a full annotated example is docs/declarative-plugins.md.
 *
 * Plugin spec: {name, version, description, apiName?, baseUrl (string | (environment) => string), auth, errors?,
 *   defaultHeaders?, extraEnv?, limits?, timeoutMs?, maxRetries?, apiRequest? (default on; false or
 *   {examplePath, apiName}), operations}.
 * Operation spec: {name, title, description, method?, path, params?, bodyMode?, write?, checkHint?, nodeOnly?,
 *   toolPolicy?, response?, job?, download?, timeoutMs?}.
 *
 * Safety semantics:
 *   - write "read" (GET/HEAD) and "idempotent" requests are retried after 5xx and network failures;
 *     "unsafe" ones never are, and their errors carry the "outcome unknown ... check before retrying" note
 *     plus the operation's `checkHint`.
 *   - path params are always encoded as one segment, so ids can never add segments.
 *   - `toolPolicy: "optIn:<ENV>"` refuses agent tool calls unless <ENV>=1; `nodeOnly` hides the tool entirely.
 *   - `api_request` is GET-only for tools, and the credential is redacted from errors and its responses.
 */
import { createApiClient } from "./api-client.mjs";
import { createApiRequestOperation } from "./api-request-operation.mjs";
import { PluginError } from "./graphrt-plugin.mjs";
import { resolveToolDeadlineMs } from "./operations.mjs";
import { createAuthorizer, createCredentialResolver, describeAuthEnv } from "./rest-auth.mjs";
import { createBodyErrorDetector, createErrorParser } from "./rest-errors.mjs";
import { runRestJob, saveDownloads } from "./rest-job.mjs";
import { buildRestRequest } from "./rest-request.mjs";
import { shapeRestResponse } from "./rest-response.mjs";
import { checkBaseUrl, hasPagination, JOB_WAIT_PARAM, TOOL_POLICY_PATTERN, validateRestSpec } from "./rest-spec-validation.mjs";

const UNKNOWN_OUTCOME_MARKER = "outcome unknown";
// A job's timeout error must reach the caller before the host (or the tool deadline) gives up.
const JOB_DEADLINE_MARGIN_MS = 5000;
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Builds a plugin definition from a declarative REST spec, validating the spec first.
 *
 * @param spec - REST plugin spec (object, see module docs and docs/declarative-plugins.md)
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
  const definition = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    ...describeCredentials(spec.auth),
    extraEnv: collectExtraEnv(restSpec),
    limits: spec.limits,
    createClient: (clientOptions) => createRestClient(spec, clientOptions),
    restSpec,
  };
  const deadlineMs = resolveToolDeadlineMs(definition);
  const jobTimeoutCapMs = Math.max(1000, deadlineMs - JOB_DEADLINE_MARGIN_MS);
  definition.operations = [...restSpec.operations.map((operation) => buildOperation(operation, jobTimeoutCapMs)), ...buildApiRequest(spec)];
  return definition;
}

function describeCredentials(auth) {
  if (auth.type === "none") return { tokenEnv: undefined, noCredentials: true };
  return { tokenEnv: describeAuthEnv(auth).tokenEnv, resolveAccessToken: createCredentialResolver(auth) };
}

function collectExtraEnv(restSpec) {
  const operationEnv = restSpec.operations.flatMap((operation) => [
    operation.toolPolicy ? TOOL_POLICY_PATTERN.exec(operation.toolPolicy)[1] : undefined,
    operation.download?.saveTo.envDir,
  ]);
  const envNames = [...describeAuthEnv(restSpec.auth).extraEnv, ...(restSpec.extraEnv ?? []), ...operationEnv].filter(Boolean);
  return [...new Set(envNames)];
}

function normalizeOperation(operation) {
  const method = (operation.method ?? "GET").toUpperCase();
  return {
    ...operation,
    method,
    params: operation.params ?? {},
    bodyMode: operation.bodyMode ?? "json",
    write: operation.write ?? "read",
    pagination: describePagination(operation.response, method),
  };
}

function describePagination(response, method) {
  if (!hasPagination(response)) return undefined;
  const style = response.cursorPath ? "cursor" : response.nextLinkHeader ? "link" : response.pagePagination ? "page" : "offset";
  return { style, paramsIn: response.paramsIn ?? (READ_METHODS.has(method) ? "query" : "body") };
}

function createRestClient(spec, { accessToken, environment, fetchImpl, resolveHostAddresses }) {
  const apiClient = createApiClient({
    baseUrl: resolveBaseUrl(spec.baseUrl, environment),
    authorize: createAuthorizer(spec.auth, accessToken, environment),
    parseError: createErrorParser(spec.errors),
    detectBodyError: createBodyErrorDetector(spec.errors),
    defaultHeaders: spec.defaultHeaders,
    timeoutMs: spec.timeoutMs,
    maxRetries: spec.maxRetries,
    fetchImpl,
  });
  const downloadFetch = fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
  return { ...apiClient, fetchImpl: downloadFetch, resolveHostAddresses };
}

/**
 * Resolves the base URL; a function receives the environment and may throw to reject bad env values.
 *
 * @param baseUrl - URL or `(environment) => string` (string | function)
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws PluginError kind `invalid_input` - When the function throws or returns a non-https URL
 */
export function resolveBaseUrl(baseUrl, environment) {
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
  checkBaseUrl(resolvedUrl, failConfiguration);
  return resolvedUrl;
}

function buildOperation(operation, jobTimeoutCapMs) {
  return {
    name: operation.name,
    title: operation.title,
    description: describeOperation(operation),
    nodeOnly: operation.nodeOnly === true,
    parameters: buildParameterSchema(operation),
    run: (context) => runOperation(operation, context, jobTimeoutCapMs),
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
  const schemaFields = {
    type: paramSpec.type,
    description: paramSpec.description,
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
  const limitWireName = response.limitParam ?? response.pagePagination?.sizeParam ?? response.offsetPagination?.limitParam;
  const properties = {
    cursor: { type: "string", description: "next_cursor from the previous call, to get the next page" },
  };
  if (limitWireName) {
    properties.limit = toPropertySchema({
      type: "integer",
      min: 1,
      max: response.maxLimit,
      default: response.defaultLimit,
      description: `Maximum items per page (sent as \`${limitWireName}\`)`,
    });
  }
  return properties;
}

function buildJobProperties(operation) {
  if (!operation.job) return {};
  const description = "Wait for the job to finish (default true); false returns the job id at once";
  return { [JOB_WAIT_PARAM]: { type: "boolean", default: true, description } };
}

async function runOperation(operation, context, jobTimeoutCapMs) {
  assertToolPolicy(operation, context);
  const { client, args, signal } = context;
  const request = buildRestRequest(operation, args);
  const response = await withUnknownOutcomeHint(operation, client.requestWithHeaders({ ...request, signal }));
  if (operation.job) {
    const jobResult = await runRestJob({ operation, client, args, createBody: response.body, environment: context.environment, signal, timeoutCapMs: jobTimeoutCapMs });
    return { data: await attachDownloads(operation, jobResult, jobResult.result, context), next_cursor: null };
  }
  const shapedResult = shapeRestResponse(operation, response, args);
  if (!operation.download) return shapedResult;
  const resultWithFiles = await attachDownloads(operation, { result: shapedResult.data }, shapedResult.data, context);
  return { data: resultWithFiles, next_cursor: shapedResult.next_cursor };
}

function assertToolPolicy(operation, { source, environment }) {
  if (!operation.toolPolicy || source !== "tool") return;
  const envName = TOOL_POLICY_PATTERN.exec(operation.toolPolicy)[1];
  if (environment?.[envName] === "1") return;
  throw new PluginError(`\`${operation.name}\` is disabled for agent tools; set ${envName}=1 to allow it, or use a workflow node`, {
    kind: "permission_denied",
  });
}

async function withUnknownOutcomeHint(operation, pendingRequest) {
  try {
    return await pendingRequest;
  } catch (requestError) {
    const isUnknownOutcome = requestError instanceof PluginError && requestError.message.includes(UNKNOWN_OUTCOME_MARKER);
    if (!isUnknownOutcome || !operation.checkHint) throw requestError;
    throw new PluginError(`${requestError.message}. To check: ${operation.checkHint}`, { kind: requestError.kind, retryable: false });
  }
}

async function attachDownloads(operation, baseData, result, context) {
  if (!operation.download || (operation.job && context.args.wait === false)) return baseData;
  const savedFiles = await saveDownloads({ operation, result, client: context.client, environment: context.environment, signal: context.signal });
  return { ...baseData, saved_files: savedFiles };
}

function buildApiRequest(spec) {
  if (spec.apiRequest === false) return [];
  const apiRequestOptions = typeof spec.apiRequest === "object" ? spec.apiRequest : {};
  const firstReadPath = spec.operations.find((operation) => !operation.path.includes("{") && READ_METHODS.has((operation.method ?? "GET").toUpperCase()))?.path;
  return [
    createApiRequestOperation({
      apiName: apiRequestOptions.apiName ?? spec.apiName ?? spec.name,
      examplePath: apiRequestOptions.examplePath ?? firstReadPath ?? "/",
    }),
  ];
}
