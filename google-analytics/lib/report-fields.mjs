/**
 * Shorthand for GA4 Data API report requests: `dimensions` and `metrics` may be plain names ("country",
 * "activeUsers") instead of `{name}` objects, which is how people and agents write them. The declarative
 * operations send objects; these wrappers convert names before the request is built. Objects pass unchanged, so
 * `{name, expression}` (custom metrics) and `{name, dimensionExpression}` still work.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const NAMED_FIELDS = ["dimensions", "metrics"];

/**
 * Converts dimension or metric names into `{name}` objects.
 *
 * @param fields - Names or objects (Array<string | object>, optional)
 * @param fieldLabel - Argument name for error messages, e.g. "dimensions" (string)
 * @returns Objects, or undefined when `fields` is undefined (object[] | undefined)
 * @throws PluginError kind `invalid_input` - An item is an empty name or not a string/object
 *
 * @example
 * normalizeNamedFields(["country", { name: "city" }], "dimensions"); // [{name: "country"}, {name: "city"}]
 */
export function normalizeNamedFields(fields, fieldLabel) {
  if (fields === undefined) return undefined;
  return fields.map((field, index) => {
    if (typeof field === "string" && field.trim() !== "") return { name: field.trim() };
    if (field && typeof field === "object" && !Array.isArray(field)) return field;
    throw new PluginError(`\`${fieldLabel}[${index}]\` must be a name like "activeUsers" or an object like {"name": "activeUsers"}`, { kind: "invalid_input" });
  });
}

/**
 * Converts the named fields of one report request (as in batchRunReports `requests[]`).
 *
 * @param request - RunReportRequest-shaped object (object)
 * @param requestLabel - Label for error messages, e.g. "requests[0]" (string)
 * @returns A copy with `{name}` objects (object)
 * @throws PluginError kind `invalid_input` - The request is not an object, or a field is invalid
 */
export function normalizeReportRequest(request, requestLabel) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new PluginError(`\`${requestLabel}\` must be a report request object`, { kind: "invalid_input" });
  }
  const normalized = { ...request };
  for (const fieldName of NAMED_FIELDS) {
    if (Array.isArray(request[fieldName])) normalized[fieldName] = normalizeNamedFields(request[fieldName], `${requestLabel}.${fieldName}`);
  }
  return normalized;
}

const NAMED_FIELD_DESCRIPTIONS = {
  dimensions: 'Dimension names, e.g. ["date", "country"] (or {"name": ...} objects)',
  metrics: 'Metric names, e.g. ["activeUsers", "sessions"] (or {"name": ..., "expression": ...} objects)',
};

// Item type removed so names and objects both pass argument validation; the wrapped run sends objects.
function relaxNamedFieldSchemas(parameters) {
  const properties = { ...parameters.properties };
  for (const fieldName of NAMED_FIELDS) {
    if (properties[fieldName]) properties[fieldName] = { type: "array", maxItems: properties[fieldName].maxItems, description: NAMED_FIELD_DESCRIPTIONS[fieldName] };
  }
  return { ...parameters, properties };
}

/**
 * Wraps a single-report operation (runReport, runRealtimeReport, runPivotReport, checkCompatibility).
 *
 * @param operation - Generated operation with `dimensions`/`metrics` array-of-object params (object)
 * @returns Operation that also accepts names (object)
 */
export function wrapReportOperation(operation) {
  return {
    ...operation,
    parameters: relaxNamedFieldSchemas(operation.parameters),
    run: (context) => {
      const args = { ...context.args };
      for (const fieldName of NAMED_FIELDS) {
        if (args[fieldName] !== undefined) args[fieldName] = normalizeNamedFields(args[fieldName], fieldName);
      }
      return operation.run({ ...context, args });
    },
  };
}

/**
 * Wraps batchRunReports so each of its `requests` accepts names too.
 *
 * @param operation - Generated batch_run_reports operation (object)
 * @returns Operation converting every request (object)
 */
export function wrapBatchReportOperation(operation) {
  return {
    ...operation,
    run: (context) => {
      const requests = context.args.requests?.map((request, index) => normalizeReportRequest(request, `requests[${index}]`));
      return operation.run({ ...context, args: { ...context.args, requests } });
    },
  };
}

/**
 * Replaces one operation of a definition with a wrapped version.
 *
 * @param definition - Plugin definition (object)
 * @param operationName - Operation to wrap (string)
 * @param wrap - `(operation) => operation` (function)
 * @returns New definition (object)
 * @throws Error - When the operation does not exist (a typo in the plugin)
 */
export function replaceOperation(definition, operationName, wrap) {
  if (!definition.operations.some((operation) => operation.name === operationName)) throw new Error(`${definition.name}: no operation \`${operationName}\` to wrap`);
  return { ...definition, operations: definition.operations.map((operation) => (operation.name === operationName ? wrap(operation) : operation)) };
}
