/**
 * Per-user tokens for agent tools: `<PLUGIN>_TOOL_TOKEN_SOURCE=context` makes every tool call take its token from
 * the host's per-call context (`tool.call` `context.secrets.access_token`, set by an `agent` node's `tool_context`)
 * instead of the plugin's env credential. Used by operations.mjs for definitions with `toolUserToken`.
 *
 * In context mode a tool call:
 *   - is refused (`auth_error`, before any request) when `access_token` is missing, empty, masked or malformed;
 *   - never reads the plugin's env credential: the definition's credential env vars (`tokenEnv` plus
 *     `toolUserToken.credentialEnv`) are removed from the environment the tool sees;
 *   - has the token scrubbed from its result and error messages (on top of the client's own redaction).
 * Nodes are unaffected, and with the env unset (or `env`) nothing changes: the mode is resolved once per process.
 */
import { PluginError } from "./graphrt-plugin.mjs";

/** Name of the `tool_context` secret that carries the end user's token. */
export const CONTEXT_TOKEN_SECRET = "access_token";
const SOURCE_ENV_SUFFIX = "_TOOL_TOKEN_SOURCE";
const SOURCE_VALUES = new Set(["env", "context"]);
// Visible ASCII only: a token is sent in a header or query, and anything else is a template or paste mistake.
const TOKEN_PATTERN = /^[\x21-\x7e]{1,8192}$/;
const MASK_PATTERN = /^\*+$/;
const REDACTED = "[redacted]";

/**
 * Names the env var that selects the tool token source, e.g. `GOOGLE_CALENDAR_TOOL_TOKEN_SOURCE`.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns Env var name, or undefined when the definition has no `toolUserToken` (string | undefined)
 */
export function toolTokenSourceEnv(pluginDefinition) {
  if (!pluginDefinition.toolUserToken) return undefined;
  return `${pluginDefinition.name.toUpperCase().replace(/-/g, "_")}${SOURCE_ENV_SUFFIX}`;
}

/**
 * Resolves the tool token mode once, when the runner is created.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param environment - Environment variables (object)
 * @returns undefined in the default mode, otherwise `{sourceEnv, toolEnvironment, configurationError?}` (object)
 */
export function resolveToolTokenMode(pluginDefinition, environment) {
  const sourceEnv = toolTokenSourceEnv(pluginDefinition);
  if (!sourceEnv) return undefined;
  const sourceValue = String(environment?.[sourceEnv] ?? "").trim().toLowerCase();
  if (sourceValue === "" || sourceValue === "env") return undefined;
  const toolEnvironment = removeCredentialEnv(pluginDefinition, environment);
  if (SOURCE_VALUES.has(sourceValue)) return { sourceEnv, toolEnvironment };
  // Refuse every tool call instead of silently running with the shared env credential.
  const configurationError = `${sourceEnv} must be \`env\` (default) or \`context\``;
  return { sourceEnv, toolEnvironment, configurationError };
}

function removeCredentialEnv(pluginDefinition, environment) {
  const credentialEnv = new Set([pluginDefinition.tokenEnv, ...(pluginDefinition.toolUserToken.credentialEnv ?? [])]);
  const toolEnvironment = Object.fromEntries(Object.entries(environment ?? {}).filter(([envName]) => !credentialEnv.has(envName)));
  return Object.freeze(toolEnvironment);
}

/**
 * Reads the end user's token from a tool call's context.
 *
 * @param toolTokenMode - Result of resolveToolTokenMode (object)
 * @param pluginName - Plugin name, for messages (string)
 * @param toolContext - The call's `{secrets}` (object, optional)
 * @returns The trimmed token (string)
 * @throws PluginError kind `invalid_input` (bad source setting) or `auth_error` (no usable token); messages never
 *   contain the value
 */
export function readContextToken(toolTokenMode, pluginName, toolContext) {
  if (toolTokenMode.configurationError) throw new PluginError(toolTokenMode.configurationError, { kind: "invalid_input" });
  const rawToken = toolContext?.secrets?.[CONTEXT_TOKEN_SECRET];
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  const modeNote = `${toolTokenMode.sourceEnv}=context`;
  if (token === "") {
    throw new PluginError(
      `No per-user token: ${modeNote}, so the agent's tool_context must set \`${CONTEXT_TOKEN_SECRET}\` for ${pluginName}; the env credential is not used for tools`,
      { kind: "auth_error" },
    );
  }
  if (MASK_PATTERN.test(token)) {
    throw new PluginError(`The per-user token arrived masked; trust the plugin so tool context secrets are passed: --trust-plugin ${pluginName}`, { kind: "auth_error" });
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new PluginError(`The per-user token (\`${CONTEXT_TOKEN_SECRET}\` in tool_context) is not a valid token (${modeNote})`, { kind: "auth_error" });
  }
  return token;
}

/**
 * Replaces every occurrence of the token (raw and URL-encoded) in a result.
 *
 * @param value - Result value (any)
 * @param token - Token to remove (string)
 * @returns The value, unchanged when it does not contain the token (any)
 */
export function scrubToken(value, token) {
  const variants = token === encodeURIComponent(token) ? [token] : [token, encodeURIComponent(token)];
  return scrubValue(value, variants);
}

function scrubValue(value, variants) {
  if (typeof value === "string") return variants.reduce((text, variant) => text.split(variant).join(REDACTED), value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, variants));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryName, entryValue]) => [entryName, scrubValue(entryValue, variants)]));
  }
  return value;
}

/**
 * Rethrows an error with the token scrubbed from its message (kind and retry hints are kept).
 *
 * @param caughtError - Error from the operation (unknown)
 * @param token - Token to remove (string)
 * @throws The scrubbed error (always)
 */
export function rethrowWithoutToken(caughtError, token) {
  const message = String(caughtError?.message ?? caughtError);
  const scrubbedMessage = scrubToken(message, token);
  if (scrubbedMessage === message && caughtError instanceof Error) throw caughtError;
  const scrubbedError = new PluginError(scrubbedMessage, { kind: caughtError?.kind, retryable: caughtError?.retryable, retryAfterMs: caughtError?.retryAfterMs });
  throw scrubbedError;
}
