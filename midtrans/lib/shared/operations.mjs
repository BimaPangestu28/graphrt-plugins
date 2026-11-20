/**
 * Turns a declarative plugin definition into graphrt nodes, tools and a manifest.
 *
 * A plugin definition looks like:
 *   {
 *     name, version, description,
 *     tokenEnv: "META_ACCESS_TOKEN",          // env var holding the default token
 *     extraEnv: ["META_PAGE_ID"],             // other env vars the plugin may read
 *     createClient: ({ accessToken, environment, fetchImpl }) => client,
 *     resolveAccessToken?: ({ environment, nodeToken }) => token | null,  // replaces the env lookup
 *     localOnly?: true,                       // no network, no secrets, no node `access_token` (e.g. desktop control)
 *     noCredentials?: true,                   // public API: network but no token, no secrets, no node `access_token`
 *     limits?: { timeout_ms, max_concurrency },
 *     operations: [{ name, title, description, parameters, run }],
 *     resolveToolOperations?: (environment) => operations | undefined,  // tools for this process (default: operations)
 *     toolUserToken?: { credentialEnv?: [...] },  // opt-in per-user tool tokens, see tool-user-token.mjs
 *   }
 * Each operation becomes node kind `<name>.<operation>` and tool `<operation>`, except operations with
 * `nodeOnly: true` (e.g. token refresh), which are never offered to an LLM as tools.
 * `run({ client, args, environment, signal, source, toolContext })` returns `{ data, next_cursor? }`; `source` is "node" or "tool". Tool calls get a deadline
 * `signal` (see resolveToolDeadlineMs) because the host cannot cancel a tool call. `toolContext` is the host's per-call
 * `{secrets}` (`tool.call` `context`, e.g. the end user's JWT); it is empty for nodes and on hosts that send none.
 * `resolveToolOperations` lets a plugin offer a different tool set per deployment (e.g. one per-user tool); the host
 * takes the tool list the plugin returns in `initialize`, so the manifest's static list is only the default.
 * `toolUserToken` adds `<PLUGIN>_TOOL_TOKEN_SOURCE`: set to `context`, tool calls use the end user's token from
 * `toolContext.secrets.access_token` (as if it were a node's `access_token`) and never the env credential; `run`
 * then also gets that token as `contextAccessToken`.
 */
import { Plugin, PluginError } from "./graphrt-plugin.mjs";
import { validateArguments } from "./params.mjs";
import { assertNoReservedParameters } from "./reserved-node-keys.mjs";
import { readContextToken, resolveToolTokenMode, rethrowWithoutToken, scrubToken, toolTokenSourceEnv } from "./tool-user-token.mjs";

const NODE_OUTPUTS = [
  { name: "data", type: "any", description: "API result" },
  { name: "next_cursor", type: "string", description: "Cursor for the next page, empty when there is none" },
];
const ACCESS_TOKEN_PROPERTY = {
  type: "string",
  description: "Overrides the plugin's default token for this node (use a secret; needs --trust-plugin)",
};
const DEFAULT_LIMITS = { timeout_ms: 120000, max_concurrency: 8 };
// A tool call must give up before the host's timeout, so its error still reaches the agent.
const TOOL_DEADLINE_MARGIN_MS = 10000;
const MIN_TOOL_DEADLINE_MS = 5000;
const EMPTY_TOOL_CONTEXT = Object.freeze({ secrets: Object.freeze({}) });

/**
 * Builds node and tool descriptors for every operation.
 *
 * @param pluginDefinition - Plugin definition (object, see module docs)
 * @returns `{nodes, tools}` ready for the manifest (object)
 * @throws Error - When a parameter name is one graphrt takes from nodes (see reserved-node-keys.mjs)
 */
export function buildDescriptors(pluginDefinition) {
  assertNoReservedParameters(pluginDefinition);
  const nodes = pluginDefinition.operations.map((operation) => ({
    kind: `${pluginDefinition.name}.${operation.name}`,
    title: operation.title,
    description: operation.description,
    category: "integration",
    config_schema: {
      ...operation.parameters,
      properties: !offersNodeToken(pluginDefinition)
        ? operation.parameters.properties
        : { ...operation.parameters.properties, access_token: ACCESS_TOKEN_PROPERTY },
    },
    outputs: NODE_OUTPUTS,
  }));
  const tools = pluginDefinition.operations
    .filter((operation) => !operation.nodeOnly)
    .map((operation) => ({
    name: operation.name,
    description: operation.description,
    parameters: operation.parameters,
  }));
  return { nodes, tools };
}

/**
 * Builds the full graphrt-plugin.json content.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns Manifest object (object)
 */
export function buildManifest(pluginDefinition) {
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  return {
    name: pluginDefinition.name,
    version: pluginDefinition.version,
    description: pluginDefinition.description,
    license: "Apache-2.0",
    runtime: "process",
    command: "node",
    args: ["plugin.mjs"],
    // secrets: true lets a node's `access_token` (from a secret) arrive unmasked once the plugin is trusted.
    // A localOnly plugin talks to no API, so it asks for neither the network nor secrets; a noCredentials plugin
    // calls a public API, so it needs the network but no secrets.
    permissions: {
      network: !pluginDefinition.localOnly,
      secrets: offersNodeToken(pluginDefinition),
      env: listPermittedEnv(pluginDefinition),
    },
    limits: { ...DEFAULT_LIMITS, ...pluginDefinition.limits },
    nodes,
    tools,
  };
}

/**
 * Whether nodes accept an `access_token` override (and the plugin therefore needs plaintext secrets).
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns False for localOnly and noCredentials plugins (boolean)
 */
export function offersNodeToken(pluginDefinition) {
  return !pluginDefinition.localOnly && !pluginDefinition.noCredentials;
}

function listPermittedEnv(pluginDefinition) {
  const envNames = [pluginDefinition.tokenEnv, ...(pluginDefinition.extraEnv ?? []), toolTokenSourceEnv(pluginDefinition)].filter(Boolean);
  return [...new Set(envNames)];
}

/**
 * Creates a function that validates arguments, picks the token and runs an operation.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param environment - Environment variables, usually process.env (object)
 * @param runnerOptions - Optional `{fetchImpl, resolveHostAddresses}` passed to createClient, for tests (object)
 * @returns `(operationName, rawArguments, {source, signal, toolContext}) => Promise<{data, next_cursor}>`
 * @throws PluginError kinds `invalid_input` (unknown operation or bad args), `auth_error` (no token)
 * @throws Error - At creation, when a parameter name is one graphrt takes from nodes (see reserved-node-keys.mjs)
 */
export function createOperationRunner(pluginDefinition, environment, runnerOptions = {}) {
  assertNoReservedParameters(pluginDefinition);
  const operationsByName = new Map(pluginDefinition.operations.map((operation) => [operation.name, operation]));
  const toolTokenMode = pluginDefinition.noCredentials ? undefined : resolveToolTokenMode(pluginDefinition, environment);
  return async (operationName, rawArguments, { source, signal, toolContext } = {}) => {
    const operation = operationsByName.get(operationName);
    if (!operation || (operation.nodeOnly && source === "tool")) {
      throw new PluginError(`Unknown operation \`${operationName}\``, { kind: "invalid_input" });
    }
    const callContext = source === "tool" && toolContext ? toolContext : EMPTY_TOOL_CONTEXT;
    if (toolTokenMode && source === "tool") {
      const contextToken = readContextToken(toolTokenMode, pluginDefinition.name, callContext);
      const callSettings = { environment: toolTokenMode.toolEnvironment, signal, toolContext: callContext, contextToken };
      return runWithContextToken(pluginDefinition, operation, rawArguments, callSettings, runnerOptions);
    }
    const args = validateArguments(operation.parameters, rawArguments);
    const accessToken = pluginDefinition.noCredentials ? undefined : await pickAccessToken(pluginDefinition, environment, rawArguments, source);
    const client = pluginDefinition.createClient(buildClientOptions(accessToken, environment, runnerOptions));
    const result = await operation.run({ client, args, environment, signal, source, toolContext: callContext });
    return { data: result?.data ?? null, next_cursor: result?.next_cursor ?? null };
  };
}

// Context mode: the end user's token stands in for a node's `access_token`; the env credential is not visible.
async function runWithContextToken(pluginDefinition, operation, rawArguments, callSettings, runnerOptions) {
  const { environment, signal, toolContext, contextToken } = callSettings;
  try {
    const args = validateArguments(operation.parameters, rawArguments);
    const accessToken = pluginDefinition.resolveAccessToken
      ? await pluginDefinition.resolveAccessToken({ environment, nodeToken: contextToken })
      : contextToken;
    const client = pluginDefinition.createClient(buildClientOptions(accessToken, environment, runnerOptions));
    const result = await operation.run({ client, args, environment, signal, source: "tool", toolContext, contextAccessToken: contextToken });
    return scrubToken({ data: result?.data ?? null, next_cursor: result?.next_cursor ?? null }, contextToken);
  } catch (caughtError) {
    rethrowWithoutToken(caughtError, contextToken);
  }
}

// Only test doubles that were given are passed, so a definition's own defaults are never overwritten with undefined.
function buildClientOptions(accessToken, environment, runnerOptions) {
  const clientOptions = { accessToken, environment, fetchImpl: runnerOptions.fetchImpl };
  if (runnerOptions.resolveHostAddresses) clientOptions.resolveHostAddresses = runnerOptions.resolveHostAddresses;
  return clientOptions;
}

/**
 * Registers every operation on a graphrt Plugin and starts the protocol loop.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param environment - Environment variables (object, default process.env)
 * @param streams - `{input, output}` for Plugin.run, for tests (object, default stdin/stdout)
 * @returns Promise that resolves when the host shuts the plugin down
 */
export function startPlugin(pluginDefinition, environment = process.env, streams = undefined) {
  const runOperation = createOperationRunner(pluginDefinition, environment);
  const toolDeadlineMs = resolveToolDeadlineMs(pluginDefinition);
  const plugin = new Plugin(pluginDefinition.name);
  for (const operation of pluginDefinition.operations) {
    plugin.node(`${pluginDefinition.name}.${operation.name}`, async (ctx, req) => ({
      outputs: await runOperation(operation.name, req.config, { source: "node", signal: ctx.signal }),
    }));
  }
  const toolOperations = pluginDefinition.resolveToolOperations?.(environment);
  const runToolOperation = toolOperations ? createOperationRunner({ ...pluginDefinition, operations: toolOperations }, environment) : runOperation;
  for (const operation of toolOperations ?? pluginDefinition.operations) {
    if (operation.nodeOnly) continue;
    const toolSpec = { name: operation.name, description: operation.description, parameters: operation.parameters };
    plugin.tool(toolSpec, createToolHandler(runToolOperation, operation.name, toolDeadlineMs));
  }
  return plugin.run(streams);
}

/**
 * How long a tool call may run: the definition's `limits.timeout_ms` (default 120000) minus 10 s, at least 5 s.
 * The protocol has no tool cancel message, so this deadline is the only way to stop a tool call's work.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns Deadline in milliseconds (number)
 *
 * @example
 * resolveToolDeadlineMs({ limits: { timeout_ms: 60000 } }); // 50000
 */
export function resolveToolDeadlineMs(pluginDefinition) {
  const { timeout_ms: timeoutMs } = { ...DEFAULT_LIMITS, ...pluginDefinition.limits };
  return Math.max(MIN_TOOL_DEADLINE_MS, timeoutMs - TOOL_DEADLINE_MARGIN_MS);
}

/**
 * Builds the tool handler for one operation: runs it with an `AbortSignal.timeout(deadlineMs)` signal.
 *
 * @param runOperation - Function from createOperationRunner (function)
 * @param operationName - Operation to run (string)
 * @param deadlineMs - Deadline for each call, from resolveToolDeadlineMs (number)
 * @returns `async (toolArguments, toolContext) => {text, data}`; toolContext is the SDK's per-call `{secrets}`
 *   (absent on older SDKs) (function)
 */
export function createToolHandler(runOperation, operationName, deadlineMs) {
  return async (toolArguments, toolContext) => {
    const output = await runOperation(operationName, toolArguments, { source: "tool", signal: AbortSignal.timeout(deadlineMs), toolContext });
    return { text: JSON.stringify(output), data: output };
  };
}

// Tools never accept a token from arguments: an LLM must not be able to choose credentials.
async function pickAccessToken(pluginDefinition, environment, rawArguments, source) {
  const rawNodeToken = source === "node" ? rawArguments?.access_token : undefined;
  const nodeToken = typeof rawNodeToken === "string" && rawNodeToken.trim() ? rawNodeToken.trim() : undefined;
  if (nodeToken && /^\*+$/.test(nodeToken)) {
    throw new PluginError(
      `The node's access_token arrived masked; trust the plugin so secrets are passed through: --trust-plugin ${pluginDefinition.name}`,
      { kind: "auth_error" },
    );
  }
  if (pluginDefinition.resolveAccessToken) return await pluginDefinition.resolveAccessToken({ environment, nodeToken });
  const accessToken = nodeToken || environment?.[pluginDefinition.tokenEnv];
  if (!accessToken) {
    throw new PluginError(
      `No access token: set the ${pluginDefinition.tokenEnv} environment variable (and allow it in permissions.env) or pass \`access_token\` on the node`,
      { kind: "auth_error" },
    );
  }
  return accessToken;
}
