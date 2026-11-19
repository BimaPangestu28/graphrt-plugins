/**
 * Route matrices are billed per element (origins x destinations), so one agent call with 50 x 50 waypoints costs
 * 2,500 elements. Tool calls are limited to GOOGLE_MAPS_TOOL_MAX_MATRIX_ELEMENTS (default 100) elements; workflow
 * nodes are unaffected and get Google's own limits (625 elements, 100 for transit or TRAFFIC_AWARE_OPTIMAL).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MATRIX_LIMIT_ENV = "GOOGLE_MAPS_TOOL_MAX_MATRIX_ELEMENTS";
const DEFAULT_TOOL_MAX_ELEMENTS = 100;

/**
 * Reads the tool element limit from the environment.
 *
 * @param environment - Environment variables (object)
 * @returns Maximum elements per tool call (number)
 * @throws PluginError kind `invalid_input` - When the env value is not a positive integer
 */
export function readToolMatrixLimit(environment) {
  const configured = environment?.[MATRIX_LIMIT_ENV]?.trim();
  if (!configured) return DEFAULT_TOOL_MAX_ELEMENTS;
  const limit = Number(configured);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new PluginError(`${MATRIX_LIMIT_ENV} must be a positive integer`, { kind: "invalid_input" });
  }
  return limit;
}

/**
 * Returns the definition with tool calls of the matrix operation limited to the element budget.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationName - The route matrix operation (string)
 * @returns A new definition (object)
 */
export function limitToolMatrixElements(pluginDefinition, operationName) {
  const wrapOperation = (operation) => {
    if (operation.name !== operationName) return operation;
    const run = (context) => {
      if (context.source === "tool") assertWithinBudget(context.args, readToolMatrixLimit(context.environment));
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function assertWithinBudget(args, maxElements) {
  const elements = (args.origins?.length ?? 0) * (args.destinations?.length ?? 0);
  if (elements <= maxElements) return;
  throw new PluginError(
    `compute_route_matrix as an agent tool is limited to ${maxElements} elements (origins x destinations); this call has ${elements}. Raise ${MATRIX_LIMIT_ENV} or use a workflow node`,
    { kind: "permission_denied" },
  );
}
