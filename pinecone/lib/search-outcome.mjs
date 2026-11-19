/**
 * Billed searches (integrated embedding and reranking) are "unsafe" so a failed call is never retried, but the
 * shared client's unknown-outcome note speaks of writes ("the write may have been applied"). A search changes no
 * data; what is unknown is whether it was billed. This wrapper rewrites that note for the given operations and keeps
 * the error's kind and `retryable: false`. Workflow nodes and tools get the same message.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const WRITE_OUTCOME_NOTE = /outcome unknown: the write may have been applied; check before retrying/;
const SEARCH_OUTCOME_NOTE = "outcome unknown: the search may have been billed; not retried to avoid a second charge";

/**
 * Rewrites a write-style unknown-outcome error into a search-style one.
 *
 * @param operationError - Error thrown by the operation (unknown)
 * @returns The same error when it has no write note, otherwise a new PluginError with the same kind (unknown)
 *
 * @example
 * describeSearchOutcome(new PluginError("API error 503 (outcome unknown: the write may have been applied; check before retrying)", { kind: "api_error", retryable: false }));
 */
export function describeSearchOutcome(operationError) {
  if (!(operationError instanceof PluginError) || !WRITE_OUTCOME_NOTE.test(operationError.message)) return operationError;
  return new PluginError(operationError.message.replace(WRITE_OUTCOME_NOTE, SEARCH_OUTCOME_NOTE), { kind: operationError.kind, retryable: false });
}

/**
 * Returns the definition with the unknown-outcome note of the named operations worded for searches.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationNames - Billed search operations (string[])
 * @returns A new definition (object)
 * @throws Error - When an operation name is missing
 */
export function rewordSearchOutcome(pluginDefinition, operationNames) {
  const names = new Set(operationNames);
  for (const name of names) {
    if (!pluginDefinition.operations.some((operation) => operation.name === name)) throw new Error(`${pluginDefinition.name}: rewordSearchOutcome: no operation ${name}`);
  }
  const wrapOperation = (operation) => {
    if (!names.has(operation.name)) return operation;
    const run = async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        throw describeSearchOutcome(operationError);
      }
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
