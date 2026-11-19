/**
 * Vercel-specific wrappers around a declarative definition:
 * - applyDefaultTeam: Vercel scopes most calls with `?teamId=`; VERCEL_TEAM_ID supplies it when a call names no team.
 * - stripSecretFieldsForTools: project objects embed env vars, protection-bypass secrets and deploy-hook URLs.
 * - clarifyInvalidTokenErrors: a readable message for Vercel's invalid-token 403.
 * The api_request path allowlist lives in tool-path-policy.mjs.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";
const TEAM_PARAM = "team_id";

/**
 * Returns the definition with `team_id` defaulting to `$envName` on every operation that has it, and with
 * `api_request` adding `teamId` to its query unless the query names `teamId` or `slug`.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param envName - Env var holding the default team id (string)
 * @returns A new definition; restSpec is unchanged (object)
 */
export function applyDefaultTeam(pluginDefinition, envName) {
  const teamScopedNames = new Set(pluginDefinition.restSpec.operations.filter((operation) => TEAM_PARAM in operation.params).map((operation) => operation.name));
  const wrapOperation = (operation) => {
    if (operation.name === "api_request") return { ...operation, run: (context) => operation.run({ ...context, args: addTeamToQuery(context.args, context.environment?.[envName]) }) };
    if (!teamScopedNames.has(operation.name)) return operation;
    return { ...operation, run: (context) => operation.run({ ...context, args: addTeamParam(context.args, context.environment?.[envName]) }) };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function addTeamParam(args, defaultTeamId) {
  if (args[TEAM_PARAM] !== undefined || !defaultTeamId?.trim()) return args;
  return { ...args, [TEAM_PARAM]: defaultTeamId.trim() };
}

function addTeamToQuery(args, defaultTeamId) {
  const query = args.query ?? {};
  const pathNamesTeam = /[?&](teamId|slug)=/.test(String(args.path));
  if (!defaultTeamId?.trim() || "teamId" in query || "slug" in query || pathNamesTeam) return args;
  return { ...args, query: { ...query, teamId: defaultTeamId.trim() } };
}

/**
 * Removes every key named in `fieldNames`, at any depth.
 *
 * @param value - API data (any)
 * @param fieldNames - Keys to drop (Set<string>)
 * @returns A copy without those keys (any)
 *
 * @example
 * stripFields({ name: "web", env: [{ value: "s" }] }, new Set(["env"])); // { name: "web" }
 */
export function stripFields(value, fieldNames) {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fieldNames));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !fieldNames.has(key))
      .map(([key, entryValue]) => [key, stripFields(entryValue, fieldNames)]),
  );
}

/**
 * Returns the definition with secret-bearing fields removed from the data of `operationNames` for agent tools, then
 * truncated like any tool result. The operations must declare `toolOutput: false`, so the layer does not truncate
 * (and so copy the secrets into a preview string) before the fields are removed.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param policy - `{operationNames: string[], fieldNames: string[]}` (object)
 * @returns A new definition (object)
 * @throws Error - A listed operation still lets the layer truncate its tool output
 */
export function stripSecretFieldsForTools(pluginDefinition, { operationNames, fieldNames }) {
  const restricted = new Set(operationNames);
  const secretFields = new Set(fieldNames);
  for (const operation of pluginDefinition.restSpec.operations.filter((candidate) => restricted.has(candidate.name))) {
    if (operation.toolOutput !== false) throw new Error(`${pluginDefinition.name}: ${operation.name} needs toolOutput: false so secrets are stripped before truncation`);
  }
  const wrapOperation = (operation) => {
    if (!restricted.has(operation.name)) return operation;
    const run = async (context) => {
      const result = await operation.run(context);
      if (context.source !== "tool") return result;
      return { ...result, data: truncateForTool(stripFields(result.data, secretFields), DEFAULT_TOOL_OUTPUT) };
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

// The errors spec maps Vercel's `invalidToken: true` flag to auth_error through codePath, which appends "(true)".
const INVALID_TOKEN_SUFFIX = " (true)";

/**
 * Returns the definition with the "(true)" of invalid-token errors replaced by "(invalid or expired token)".
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function clarifyInvalidTokenErrors(pluginDefinition) {
  const wrapOperation = (operation) => ({
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        throw rewordInvalidTokenError(operationError);
      }
    },
  });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function rewordInvalidTokenError(operationError) {
  if (operationError?.kind !== "auth_error" || !operationError.message?.includes(INVALID_TOKEN_SUFFIX)) return operationError;
  const message = operationError.message.replace(INVALID_TOKEN_SUFFIX, " (invalid or expired token)");
  return new PluginError(message, { kind: "auth_error", retryable: operationError.retryable, retryAfterMs: operationError.retryAfterMs });
}
