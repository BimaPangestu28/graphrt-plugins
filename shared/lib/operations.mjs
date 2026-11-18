/**
 * Turns a declarative plugin definition into graphrt nodes, tools and a manifest.
 *
 * A plugin definition looks like:
 *   {
 *     name, version, description,
 *     tokenEnv: "META_ACCESS_TOKEN",          // env var holding the default token
 *     extraEnv: ["META_PAGE_ID"],             // other env vars the plugin may read
 *     createClient: ({ accessToken, environment }) => client,
 *     operations: [{ name, title, description, parameters, run }],
 *   }
 * Each operation becomes node kind `<name>.<operation>` and tool `<operation>`.
 * `run({ client, args, environment, signal })` returns `{ data, next_cursor? }`.
 */
import { Plugin, PluginError } from "./graphrt-plugin.mjs";
import { validateArguments } from "./params.mjs";

const NODE_OUTPUTS = [
  { name: "data", type: "any", description: "API result" },
  { name: "next_cursor", type: "string", description: "Cursor for the next page, empty when there is none" },
];
const ACCESS_TOKEN_PROPERTY = {
  type: "string",
  description: "Overrides the plugin's default token for this node (use a secret; needs --trust-plugin)",
};
const DEFAULT_LIMITS = { timeout_ms: 120000, max_concurrency: 8 };

/**
 * Builds node and tool descriptors for every operation.
 *
 * @param pluginDefinition - Plugin definition (object, see module docs)
 * @returns `{nodes, tools}` ready for the manifest (object)
 */
export function buildDescriptors(pluginDefinition) {
  const nodes = pluginDefinition.operations.map((operation) => ({
    kind: `${pluginDefinition.name}.${operation.name}`,
    title: operation.title,
    description: operation.description,
    category: "integration",
    config_schema: {
      ...operation.parameters,
      properties: { ...operation.parameters.properties, access_token: ACCESS_TOKEN_PROPERTY },
    },
    outputs: NODE_OUTPUTS,
  }));
  const tools = pluginDefinition.operations.map((operation) => ({
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
    permissions: { network: true, env: [pluginDefinition.tokenEnv, ...(pluginDefinition.extraEnv ?? [])] },
    limits: { ...DEFAULT_LIMITS, ...pluginDefinition.limits },
    nodes,
    tools,
  };
}

/**
 * Creates a function that validates arguments, picks the token and runs an operation.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param environment - Environment variables, usually process.env (object)
 * @param runnerOptions - Optional `{fetchImpl}` passed to createClient, for tests (object)
 * @returns `(operationName, rawArguments, {source, signal}) => Promise<{data, next_cursor}>`
 * @throws PluginError kinds `invalid_input` (unknown operation or bad args), `auth_error` (no token)
 */
export function createOperationRunner(pluginDefinition, environment, runnerOptions = {}) {
  const operationsByName = new Map(pluginDefinition.operations.map((operation) => [operation.name, operation]));
  return async (operationName, rawArguments, { source, signal } = {}) => {
    const operation = operationsByName.get(operationName);
    if (!operation) throw new PluginError(`Unknown operation \`${operationName}\``, { kind: "invalid_input" });
    const args = validateArguments(operation.parameters, rawArguments);
    const accessToken = pickAccessToken(pluginDefinition, environment, rawArguments, source);
    const client = pluginDefinition.createClient({ accessToken, environment, fetchImpl: runnerOptions.fetchImpl });
    const result = await operation.run({ client, args, environment, signal });
    return { data: result?.data ?? null, next_cursor: result?.next_cursor ?? null };
  };
}

/**
 * Registers every operation on a graphrt Plugin and starts the protocol loop.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param environment - Environment variables (object, default process.env)
 * @returns Promise that resolves when the host shuts the plugin down
 */
export function startPlugin(pluginDefinition, environment = process.env) {
  const runOperation = createOperationRunner(pluginDefinition, environment);
  const plugin = new Plugin(pluginDefinition.name);
  for (const operation of pluginDefinition.operations) {
    plugin.node(`${pluginDefinition.name}.${operation.name}`, async (ctx, req) => ({
      outputs: await runOperation(operation.name, req.config, { source: "node", signal: ctx.signal }),
    }));
    plugin.tool({ name: operation.name, description: operation.description, parameters: operation.parameters }, async (toolArguments) => {
      const output = await runOperation(operation.name, toolArguments, { source: "tool" });
      return { text: JSON.stringify(output), data: output };
    });
  }
  return plugin.run();
}

// Tools never accept a token from arguments: an LLM must not be able to choose credentials.
function pickAccessToken(pluginDefinition, environment, rawArguments, source) {
  const nodeToken = source === "node" ? rawArguments?.access_token : undefined;
  const accessToken = (typeof nodeToken === "string" && nodeToken.trim()) || environment?.[pluginDefinition.tokenEnv];
  if (!accessToken) {
    throw new PluginError(
      `No access token: set the ${pluginDefinition.tokenEnv} environment variable (and allow it in permissions.env) or pass \`access_token\` on the node`,
      { kind: "auth_error" },
    );
  }
  return accessToken;
}
