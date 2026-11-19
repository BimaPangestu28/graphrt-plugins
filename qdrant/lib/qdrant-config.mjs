/**
 * Qdrant-specific configuration for the declarative definition:
 * - resolveQdrantBaseUrl: QDRANT_URL (Qdrant Cloud or self-hosted; default http://localhost:6333). The layer then
 *   requires https, or http only on localhost.
 * - optional API key: a local Qdrant usually runs without one, so QDRANT_API_KEY may be unset; when it is set (or a
 *   node passes access_token) it is sent as the `api-key` header and redacted like any credential.
 * - withNumericScrollCursor: Qdrant point ids are unsigned integers or UUIDs, and `next_page_offset` is one of them.
 *   The layer hands cursors back as strings, and Qdrant refuses "42" where it expects the integer 42, so a digit-only
 *   cursor is sent as a number.
 */
export const QDRANT_URL_ENV = "QDRANT_URL";
export const QDRANT_API_KEY_ENV = "QDRANT_API_KEY";
const DEFAULT_QDRANT_URL = "http://localhost:6333";
const DIGITS_ONLY = /^\d+$/;

/**
 * Reads the Qdrant base URL from the environment.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL without a trailing slash (string)
 *
 * @example
 * resolveQdrantBaseUrl({ QDRANT_URL: "https://xyz.eu-central-1-0.aws.cloud.qdrant.io:6333/" });
 * // "https://xyz.eu-central-1-0.aws.cloud.qdrant.io:6333"
 */
export function resolveQdrantBaseUrl(environment) {
  const configuredUrl = typeof environment[QDRANT_URL_ENV] === "string" ? environment[QDRANT_URL_ENV].trim() : "";
  return (configuredUrl || DEFAULT_QDRANT_URL).replace(/\/+$/, "");
}

/**
 * Credential resolver that allows running without a key: the node's access_token, else QDRANT_API_KEY, else null.
 *
 * @param input - `{environment, nodeToken}` (object)
 * @returns The key, or null for an unauthenticated local server (string | null)
 */
export function resolveOptionalApiKey({ environment, nodeToken }) {
  if (nodeToken) return nodeToken;
  const apiKey = typeof environment?.[QDRANT_API_KEY_ENV] === "string" ? environment[QDRANT_API_KEY_ENV].trim() : "";
  return apiKey || null;
}

/**
 * Custom-auth hook: sets `api-key` only when there is a key (the layer redacts the credential itself).
 *
 * @param request - `{headers, credential}` from the declarative layer (object)
 * @returns Extra secrets to redact (string[])
 */
export function authorizeWithOptionalKey({ headers, credential }) {
  if (credential) headers["api-key"] = credential;
  return [];
}

/**
 * Returns the definition with digit-only `cursor` arguments of the named operations turned into integers.
 *
 * @param pluginDefinition - Definition (object)
 * @param operationNames - Operations whose cursor is a Qdrant point id (string[])
 * @returns A new definition (object)
 */
export function withNumericScrollCursor(pluginDefinition, operationNames) {
  const scrollNames = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!scrollNames.has(operation.name)) return operation;
    const run = (context) => {
      const cursor = context.args?.cursor;
      const isIntegerId = typeof cursor === "string" && DIGITS_ONLY.test(cursor) && Number.isSafeInteger(Number(cursor));
      return operation.run(isIntegerId ? { ...context, args: { ...context.args, cursor: Number(cursor) } } : context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
