/**
 * Agent-tool rules for Supabase database functions (RPC, `POST /rest/v1/rpc/{name}`), configured by env:
 *   SUPABASE_TOOL_MODE=user_rpc     the only tool is `call_function`, sent as the end user: `apikey` is SUPABASE_KEY
 *                                   (publishable/anon) and `Authorization: Bearer <user_jwt>` comes from the host's
 *                                   per-call tool context (agent `tool_context`), never from env or the model
 *   SUPABASE_TOOL_RPC_ALLOWLIST     comma list of function names a tool may call (required in user_rpc mode)
 *   SUPABASE_TOOL_TIMEOUT_MS        deadline of one tool RPC (default 30000)
 *   SUPABASE_TOOL_MAX_ROWS          array results are cut to this many rows, with a note (default 100)
 * The allowlist, timeout and row cap also apply to the `call_function` tool of the default mode. Workflow nodes are
 * unaffected. The user JWT is redacted from every result and error and never logged.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { truncateForTool } from "./shared/rest-response.mjs";

export const TOOL_MODE_ENV = "SUPABASE_TOOL_MODE";
export const USER_RPC_MODE = "user_rpc";
export const RPC_ALLOWLIST_ENV = "SUPABASE_TOOL_RPC_ALLOWLIST";
export const TOOL_TIMEOUT_ENV = "SUPABASE_TOOL_TIMEOUT_MS";
export const TOOL_MAX_ROWS_ENV = "SUPABASE_TOOL_MAX_ROWS";
export const RPC_TOOL_ENV = [TOOL_MODE_ENV, RPC_ALLOWLIST_ENV, TOOL_TIMEOUT_ENV, TOOL_MAX_ROWS_ENV];
/** Name of the tool context secret that carries the end user's access token. */
export const USER_JWT_SECRET = "user_jwt";

const DEFAULT_TIMEOUT_MS = 30000;
const TIMEOUT_RANGE_MS = [1000, 120000];
const DEFAULT_MAX_ROWS = 100;
const MAX_ROWS_RANGE = [1, 1000];
const MAX_TOOL_CHARS = 100000;
const FUNCTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;
const SECRET_KEY_PREFIX = "sb_secret_";

/**
 * Whether the plugin runs in per-user RPC mode.
 *
 * @param environment - Environment variables (object)
 * @returns True for SUPABASE_TOOL_MODE=user_rpc (boolean)
 * @throws Error - SUPABASE_TOOL_MODE has another value than "", "default" or "user_rpc"
 */
export function isUserRpcMode(environment) {
  const mode = environment?.[TOOL_MODE_ENV]?.trim().toLowerCase() ?? "";
  if (mode === "" || mode === "default") return false;
  if (mode === USER_RPC_MODE) return true;
  throw new Error(`${TOOL_MODE_ENV} must be "default" or "${USER_RPC_MODE}", not "${mode}"`);
}

/**
 * Reads the RPC tool settings from env.
 *
 * @param environment - Environment variables (object)
 * @returns `{allowlist: string[] | undefined, timeoutMs, maxRows}`; allowlist is undefined when unset (object)
 * @throws PluginError kind `invalid_input` - A malformed setting (the message names the variable)
 *
 * @example
 * readRpcToolSettings({ SUPABASE_TOOL_RPC_ALLOWLIST: "get_balance, list_orders" });
 * // { allowlist: ["get_balance", "list_orders"], timeoutMs: 30000, maxRows: 100 }
 */
export function readRpcToolSettings(environment) {
  return {
    allowlist: parseAllowlist(environment?.[RPC_ALLOWLIST_ENV]),
    timeoutMs: readIntegerSetting(environment, TOOL_TIMEOUT_ENV, DEFAULT_TIMEOUT_MS, TIMEOUT_RANGE_MS),
    maxRows: readIntegerSetting(environment, TOOL_MAX_ROWS_ENV, DEFAULT_MAX_ROWS, MAX_ROWS_RANGE),
  };
}

function parseAllowlist(rawValue) {
  if (rawValue === undefined || rawValue.trim() === "") return undefined;
  const names = [...new Set(rawValue.split(",").map((entry) => entry.trim()).filter(Boolean))];
  const invalidName = names.find((name) => !FUNCTION_NAME_PATTERN.test(name));
  if (invalidName !== undefined) throw configError(`${RPC_ALLOWLIST_ENV} has "${invalidName}", which is not a plain function name`);
  return names;
}

function readIntegerSetting(environment, envName, defaultValue, [minimum, maximum]) {
  const rawValue = environment?.[envName]?.trim();
  if (!rawValue) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configError(`${envName} must be a whole number from ${minimum} to ${maximum}, not "${rawValue}"`);
  }
  return value;
}

function configError(message) {
  return new PluginError(`Plugin configuration: ${message}`, { kind: "invalid_input" });
}

/**
 * Refuses a function the allowlist does not name. Model-written names are untrusted (prompt injection), so the
 * check is exact and happens before any request.
 *
 * @param functionName - Name the model asked for (string)
 * @param allowlist - Allowed names, or undefined when any is allowed (string[] | undefined)
 * @param isListRequired - Refuse everything when there is no allowlist (boolean)
 * @throws PluginError kind `permission_denied` - The function is not allowed
 */
export function assertFunctionAllowed(functionName, allowlist, isListRequired) {
  if (allowlist === undefined && !isListRequired) return;
  if (allowlist === undefined) {
    throw new PluginError(`No database function may be called: set ${RPC_ALLOWLIST_ENV} to the functions this agent may use`, { kind: "permission_denied" });
  }
  if (allowlist.includes(functionName)) return;
  throw new PluginError(
    `Function "${String(functionName).slice(0, 80)}" is not allowed for this agent. Allowed functions: ${allowlist.join(", ")}`,
    { kind: "permission_denied" },
  );
}

/**
 * Cuts an array result to `maxRows` rows and says so; other results only get the size cap.
 *
 * @param data - RPC result (any)
 * @param maxRows - Row cap (number)
 * @returns The data, or `{truncated, items, total_items, note}` (any)
 */
export function capToolRows(data, maxRows) {
  const shortened = truncateForTool(data, { maxItems: maxRows, maxChars: MAX_TOOL_CHARS });
  if (!Array.isArray(data) || data.length <= maxRows || shortened?.items === undefined) return shortened;
  const note = `Only the first ${maxRows} of ${data.length} rows are shown (${TOOL_MAX_ROWS_ENV}); ask for fewer rows if you need the rest`;
  return { ...shortened, note };
}

/**
 * Wraps the default mode's `call_function` so its tool calls follow the allowlist, timeout and row cap.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationName - The RPC operation (string)
 * @returns A new definition (object)
 */
export function applyRpcToolLimits(pluginDefinition, operationName) {
  const limitOperation = (operation) => {
    if (operation.name !== operationName) return operation;
    const run = async (context) => {
      if (context.source !== "tool") return operation.run(context);
      const settings = readRpcToolSettings(context.environment);
      assertFunctionAllowed(context.args.function_name, settings.allowlist, false);
      const signal = combineSignals(context.signal, settings.timeoutMs);
      const result = await runWithTimeout(() => operation.run({ ...context, signal }), signal, settings.timeoutMs);
      return { ...result, data: capToolRows(result.data, settings.maxRows) };
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(limitOperation) };
}

function combineSignals(callerSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

async function runWithTimeout(runRequest, signal, timeoutMs) {
  try {
    return await runRequest();
  } catch (error) {
    if (signal.reason?.name !== "TimeoutError") throw error;
    throw new PluginError(
      `The database function did not answer within ${timeoutMs} ms (${TOOL_TIMEOUT_ENV}); it may still have run, check before calling it again`,
      { kind: "timeout" },
    );
  }
}

/**
 * Builds the per-user `call_function` tool operation of user_rpc mode.
 *
 * @param options - Settings (object)
 * @param options.environment - Environment variables; the allowlist names become the parameter's enum (object)
 * @param options.errors - The plugin's REST `errors` spec, to map PostgREST errors (object)
 * @param options.createErrorParser - rest-errors.mjs createErrorParser (function)
 * @returns Operation `{name, title, description, parameters, run}` for operations.mjs (object)
 */
export function createUserRpcOperation({ environment, errors, createErrorParser }) {
  const allowlist = safeAllowlist(environment);
  const functionNameSchema = { type: "string", description: "Function name" };
  if (allowlist?.length) functionNameSchema.enum = allowlist;
  return {
    name: "call_function",
    title: "Call database function as the user",
    description:
      "Call an allowed Postgres function (RPC) as the signed-in end user; row level security applies, so results " +
      `only include what this user may see${allowlist?.length ? `. Allowed: ${allowlist.join(", ")}` : ""}`,
    parameters: {
      type: "object",
      properties: {
        function_name: functionNameSchema,
        arguments: { type: "object", description: "Named arguments, e.g. {\"order_id\": 7}" },
      },
      required: ["function_name"],
    },
    run: (context) => callFunctionAsUser(context, createErrorParser(errors)),
  };
}

// A bad allowlist must not stop the plugin from starting; every call reports it instead.
function safeAllowlist(environment) {
  try {
    return parseAllowlist(environment?.[RPC_ALLOWLIST_ENV]);
  } catch {
    return undefined;
  }
}

async function callFunctionAsUser({ client, args, environment, signal, toolContext }, parseError) {
  const settings = readRpcToolSettings(environment);
  assertFunctionAllowed(args.function_name, settings.allowlist, true);
  const userJwt = readUserJwt(toolContext);
  const publishableKey = readPublishableKey(environment);
  const rpcClient = createApiClient({
    baseUrl: client.baseUrl,
    fetchImpl: client.fetchImpl,
    authorize: ({ headers }) => {
      headers.apikey = publishableKey;
      headers.authorization = `Bearer ${userJwt}`;
      return [userJwt, publishableKey];
    },
    parseError,
    timeoutMs: settings.timeoutMs,
    maxRetries: 0,
  });
  const combinedSignal = combineSignals(signal, settings.timeoutMs);
  const body = await runWithTimeout(
    () => rpcClient.request({ method: "POST", path: `/rest/v1/rpc/${args.function_name}`, json: args.arguments ?? {}, signal: combinedSignal, redactResponse: true }),
    combinedSignal,
    settings.timeoutMs,
  ).catch((error) => {
    throw scrubError(error, userJwt);
  });
  return { data: capToolRows(body ?? null, settings.maxRows), next_cursor: null };
}

/**
 * Reads the end user's JWT from the host's per-call tool context.
 *
 * @param toolContext - `{secrets}` from the tool call (object)
 * @returns The JWT (string)
 * @throws PluginError kind `auth_error` - Missing, masked or not a JWT, or a service_role token
 */
export function readUserJwt(toolContext) {
  const userJwt = toolContext?.secrets?.[USER_JWT_SECRET]?.trim();
  const match = userJwt ? JWT_PATTERN.exec(userJwt) : null;
  if (!match) {
    throw new PluginError(
      `No signed-in user for this call: the agent node must pass the user's access token as tool_context.supabase.${USER_JWT_SECRET}, ` +
        "and the plugin must be trusted (--trust-plugin supabase). The call was refused",
      { kind: "auth_error" },
    );
  }
  if (readJwtRole(match[1]) === "service_role") {
    throw new PluginError("The user token has the service_role role, which bypasses row level security; pass the end user's access token", { kind: "auth_error" });
  }
  return userJwt;
}

function readJwtRole(encodedPayload) {
  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))?.role;
  } catch {
    return undefined;
  }
}

// user_rpc never sends a key that bypasses row level security, not even as `apikey`.
function readPublishableKey(environment) {
  const key = environment.SUPABASE_KEY?.trim() ?? "";
  const legacyPayload = JWT_PATTERN.exec(key)?.[1];
  if (key.startsWith(SECRET_KEY_PREFIX) || (legacyPayload && readJwtRole(legacyPayload) === "service_role")) {
    throw new PluginError(
      `${TOOL_MODE_ENV}=${USER_RPC_MODE} needs SUPABASE_KEY to be the publishable (sb_publishable_...) or anon key, not a secret or service_role key`,
      { kind: "auth_error" },
    );
  }
  return key;
}

// Defense in depth: the API client already redacts credentials, but nothing the user JWT touches may leave unscrubbed.
function scrubError(error, userJwt) {
  if (!(error instanceof Error) || !error.message.includes(userJwt)) return error;
  return new PluginError(error.message.replaceAll(userJwt, "******"), { kind: error.kind ?? "api_error", retryable: error.retryable });
}
