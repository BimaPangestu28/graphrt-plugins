/**
 * Builds BigQuery query parameters. SQL refers to them as @name (an object of params) or ? (an array), so values
 * are never spliced into the SQL text.
 *
 * Inferred types: string -> STRING, integer -> INT64, other numbers -> FLOAT64, boolean -> BOOL, null -> STRING
 * NULL, arrays of one scalar type -> ARRAY<T>. Anything else needs an explicit `{"type": "DATE", "value": "..."}`
 * (also NUMERIC, TIMESTAMP, BYTES, JSON, ... and "ARRAY<T>" with an array value).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SCALAR_TYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ARRAY_TYPE_PATTERN = /^ARRAY<([A-Z][A-Z0-9_]*)>$/;

/**
 * Converts `params` into the jobs.query parameter fields.
 *
 * @param params - Named params (object), positional params (array) or undefined
 * @returns `{parameterMode, queryParameters}`, or `{}` without params (object)
 * @throws PluginError kind `invalid_input` - Bad names, mixed or empty arrays, untyped objects, inexact integers
 *
 * @example
 * buildQueryParameters({ city: "Jakarta" });
 * // { parameterMode: "NAMED", queryParameters: [{ name: "city", parameterType: { type: "STRING" }, parameterValue: { value: "Jakarta" } }] }
 */
export function buildQueryParameters(params) {
  if (params === undefined) return {};
  if (Array.isArray(params)) {
    return { parameterMode: "POSITIONAL", queryParameters: params.map((value, index) => buildParameter(value, `params[${index}]`)) };
  }
  const queryParameters = Object.entries(params).map(([parameterName, value]) => {
    if (!PARAMETER_NAME_PATTERN.test(parameterName)) throw invalidParameter(`Parameter name ${JSON.stringify(parameterName)} must be letters, digits and _`);
    return { name: parameterName, ...buildParameter(value, `params.${parameterName}`) };
  });
  return { parameterMode: "NAMED", queryParameters };
}

function buildParameter(value, label) {
  if (isExplicitlyTyped(value)) return buildTypedParameter(value, label);
  if (Array.isArray(value)) return buildArrayParameter(value, label);
  const type = inferScalarType(value, label);
  return { parameterType: { type }, parameterValue: value === null ? {} : { value: formatScalar(value, label) } };
}

function isExplicitlyTyped(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string" && "value" in value;
}

function buildTypedParameter({ type, value }, label) {
  const arrayMatch = ARRAY_TYPE_PATTERN.exec(type);
  if (arrayMatch) {
    if (!Array.isArray(value)) throw invalidParameter(`${label}: type ${type} needs an array value`);
    return { parameterType: { type: "ARRAY", arrayType: { type: arrayMatch[1] } }, parameterValue: { arrayValues: value.map((element) => ({ value: formatScalar(element, label) })) } };
  }
  if (!SCALAR_TYPE_PATTERN.test(type)) throw invalidParameter(`${label}: ${JSON.stringify(type)} is not a BigQuery type name such as DATE or ARRAY<STRING>`);
  return { parameterType: { type }, parameterValue: value === null ? {} : { value: formatScalar(value, label) } };
}

function buildArrayParameter(values, label) {
  if (values.length === 0) throw invalidParameter(`${label} is an empty array; pass {"type": "ARRAY<STRING>", "value": []} to give it a type`);
  const elementTypes = new Set(values.map((element) => inferScalarType(element, label)));
  if (elementTypes.size !== 1 || values.includes(null)) throw invalidParameter(`${label}: array elements must all have the same type and not be null`);
  return { parameterType: { type: "ARRAY", arrayType: { type: [...elementTypes][0] } }, parameterValue: { arrayValues: values.map((element) => ({ value: formatScalar(element, label) })) } };
}

function inferScalarType(value, label) {
  if (value === null || typeof value === "string") return "STRING";
  if (typeof value === "boolean") return "BOOL";
  if (typeof value === "number" && Number.isInteger(value)) return "INT64";
  if (typeof value === "number" && Number.isFinite(value)) return "FLOAT64";
  throw invalidParameter(`${label} has no BigQuery type; pass {"type": "...", "value": ...}`);
}

function formatScalar(value, label) {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw invalidParameter(`${label} is too large to be exact; pass it as a string with {"type": "INT64", "value": "..."}`);
  if (value !== null && typeof value === "object") throw invalidParameter(`${label} has no BigQuery type; pass {"type": "...", "value": ...}`);
  return String(value);
}

function invalidParameter(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
