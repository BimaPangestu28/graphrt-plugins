/**
 * Parameter schemas and checks shared by the x-api operations.
 *
 * The shared validator does not know `pattern`, so `withPatternChecks` wraps
 * an operation and enforces the `pattern` of every string (or string-array)
 * property before it runs. Ids end up in URL paths, so this also keeps
 * values like "../users/me" out of them.
 */
import { rejectInput } from "./client.mjs";

export const NUMERIC_ID_PATTERN = "^[0-9]{1,19}$";
const QUERY_PARAMS_VALUE_TYPES = new Set(["string", "number", "boolean"]);

/**
 * Builds a numeric X id property.
 *
 * @param description - Property description (string)
 * @returns JSON-schema property (object)
 */
export function numericIdProperty(description) {
  return { type: "string", pattern: NUMERIC_ID_PATTERN, description };
}

export const QUERY_PARAMS_PROPERTY = {
  type: "object",
  description: 'Extra query parameters merged into the request, e.g. {"tweet.fields": "created_at,public_metrics", "expansions": "author_id"}',
};

/**
 * Builds the `limit`/`cursor` properties for an endpoint's max_results range.
 *
 * @param range - `{minimum, maximum, defaultLimit}` (object)
 * @returns JSON-schema properties `{limit, cursor}` (object)
 */
export function paginationProperties({ minimum, maximum = 100, defaultLimit = 10 }) {
  return {
    limit: { type: "integer", minimum, maximum, default: defaultLimit, description: `Page size (${minimum}-${maximum}); X bills per item read` },
    cursor: { type: "string", description: "next_cursor from a previous call" },
  };
}

/**
 * Merges the caller's `query_params` under the operation's own parameters,
 * so query_params can add fields/expansions but never override pagination or the query.
 *
 * @param queryParams - Caller-supplied extra parameters (object | undefined)
 * @param operationQuery - Parameters set by the operation (object)
 * @returns Combined query (object)
 * @throws PluginError kind `invalid_input` - When a query_params value is not a scalar or array
 */
export function mergeQueryParams(queryParams, operationQuery) {
  for (const [parameterName, parameterValue] of Object.entries(queryParams ?? {})) {
    const isAllowedValue = Array.isArray(parameterValue) || QUERY_PARAMS_VALUE_TYPES.has(typeof parameterValue);
    if (!isAllowedValue) rejectInput(`\`query_params.${parameterName}\` must be a string, number, boolean or array`);
  }
  const definedOperationQuery = Object.fromEntries(Object.entries(operationQuery).filter(([, queryValue]) => queryValue !== undefined));
  return { ...queryParams, ...definedOperationQuery };
}

/**
 * Wraps an operation so every `pattern` in its parameter schema is enforced.
 *
 * @param operation - Operation definition (object)
 * @returns Operation with a checking `run` (object)
 */
export function withPatternChecks(operation) {
  const patternProperties = Object.entries(operation.parameters.properties).filter(([, propertySchema]) => readPattern(propertySchema));
  if (patternProperties.length === 0) return operation;
  return {
    ...operation,
    run: (runContext) => {
      for (const [propertyName, propertySchema] of patternProperties) checkPattern(propertyName, propertySchema, runContext.args[propertyName]);
      return operation.run(runContext);
    },
  };
}

function readPattern(propertySchema) {
  return propertySchema.pattern ?? propertySchema.items?.pattern;
}

function checkPattern(propertyName, propertySchema, value) {
  if (value === undefined) return;
  const pattern = new RegExp(readPattern(propertySchema));
  const values = Array.isArray(value) ? value : [value];
  if (values.every((item) => pattern.test(String(item)))) return;
  rejectInput(`\`${propertyName}\` has an invalid format (expected ${pattern.source})`);
}

/**
 * Throws unless exactly one of two arguments is set.
 *
 * @param args - Validated arguments (object)
 * @param firstName - First argument name (string)
 * @param secondName - Second argument name (string)
 * @throws PluginError kind `invalid_input`
 */
export function requireExactlyOne(args, firstName, secondName) {
  const isFirstSet = args[firstName] !== undefined;
  const isSecondSet = args[secondName] !== undefined;
  if (isFirstSet === isSecondSet) rejectInput(`Pass exactly one of \`${firstName}\` or \`${secondName}\``);
}
