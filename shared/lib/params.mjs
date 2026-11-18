/**
 * Minimal JSON-Schema-style argument validation for plugin operations.
 *
 * Supports the subset the operation schemas use: type (string, integer,
 * number, boolean, array, object), enum, minimum/maximum, minLength,
 * maxItems, items.type, default and required. Values from graphrt templates
 * arrive as strings, so scalar and array fields are coerced from strings.
 */
import { PluginError } from "./graphrt-plugin.mjs";

/**
 * Validates arguments against an object schema, applying defaults and coercion.
 *
 * @param schema - Object schema with `properties` and optional `required` (object)
 * @param rawArguments - Node config or tool arguments (object)
 * @returns New object with only declared, validated properties (object)
 * @throws PluginError kind `invalid_input` - When a value is missing or invalid
 *
 * @example
 * validateArguments({ properties: { limit: { type: "integer", default: 25 } } }, { limit: "10" });
 * // { limit: 10 }
 */
export function validateArguments(schema, rawArguments) {
  const properties = schema?.properties ?? {};
  const requiredNames = new Set(schema?.required ?? []);
  const validated = {};
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const rawValue = rawArguments?.[propertyName];
    if (isMissing(rawValue)) {
      if (requiredNames.has(propertyName)) throw invalidArgument(propertyName, "is required");
      if (propertySchema.default !== undefined) validated[propertyName] = structuredClone(propertySchema.default);
      continue;
    }
    validated[propertyName] = validateValue(propertyName, propertySchema, rawValue);
  }
  return validated;
}

function isMissing(value) {
  return value === undefined || value === null || value === "";
}

function validateValue(propertyName, propertySchema, rawValue) {
  const value = coerceValue(propertySchema.type, rawValue);
  checkType(propertyName, propertySchema, value);
  checkConstraints(propertyName, propertySchema, value);
  return value;
}

function coerceValue(declaredType, rawValue) {
  if (typeof rawValue !== "string") return rawValue;
  const trimmed = rawValue.trim();
  if ((declaredType === "integer" || declaredType === "number") && trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  if (declaredType === "boolean" && (trimmed === "true" || trimmed === "false")) return trimmed === "true";
  if ((declaredType === "array" && trimmed.startsWith("[")) || (declaredType === "object" && trimmed.startsWith("{"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

function checkType(propertyName, propertySchema, value) {
  const declaredType = propertySchema.type;
  const typeCheckers = {
    string: (candidate) => typeof candidate === "string",
    integer: (candidate) => Number.isInteger(candidate),
    number: (candidate) => typeof candidate === "number" && Number.isFinite(candidate),
    boolean: (candidate) => typeof candidate === "boolean",
    array: (candidate) => Array.isArray(candidate),
    object: (candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate),
  };
  const isValidType = typeCheckers[declaredType] ?? (() => true);
  if (!isValidType(value)) throw invalidArgument(propertyName, `must be of type ${declaredType}`);
  if (declaredType === "array" && propertySchema.items?.type) {
    value.forEach((item, index) => checkType(`${propertyName}[${index}]`, propertySchema.items, item));
  }
}

function checkConstraints(propertyName, propertySchema, value) {
  if (propertySchema.enum && !propertySchema.enum.includes(value)) {
    throw invalidArgument(propertyName, `must be one of ${propertySchema.enum.join(", ")}`);
  }
  if (propertySchema.minimum !== undefined && value < propertySchema.minimum) {
    throw invalidArgument(propertyName, `must be >= ${propertySchema.minimum}`);
  }
  if (propertySchema.maximum !== undefined && value > propertySchema.maximum) {
    throw invalidArgument(propertyName, `must be <= ${propertySchema.maximum}`);
  }
  if (propertySchema.minLength !== undefined && value.length < propertySchema.minLength) {
    throw invalidArgument(propertyName, `must have at least ${propertySchema.minLength} characters`);
  }
  if (propertySchema.maxItems !== undefined && value.length > propertySchema.maxItems) {
    throw invalidArgument(propertyName, `must have at most ${propertySchema.maxItems} items`);
  }
}

function invalidArgument(propertyName, problem) {
  return new PluginError(`\`${propertyName}\` ${problem}`, { kind: "invalid_input" });
}
