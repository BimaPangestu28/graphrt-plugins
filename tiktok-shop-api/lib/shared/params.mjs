/**
 * Minimal JSON-Schema-style argument validation for plugin operations.
 *
 * Supports the subset the operation schemas use: type (string, integer,
 * number, boolean, array, object), enum, minimum/maximum, minLength,
 * maxItems, items.type, default and required. Values from graphrt templates
 * arrive as strings, so scalar and array fields are coerced from strings.
 */
import { PluginError } from "./graphrt-plugin.mjs";

const BOOLEAN_STRINGS = new Map([
  ["true", true],
  ["false", false],
  ["1", true],
  ["0", false],
]);

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
  const value = canonicalizeEnum(propertySchema.enum, coerceArrayItems(propertySchema, coerceValue(propertySchema.type, rawValue)));
  checkType(propertyName, propertySchema, value);
  checkConstraints(propertyName, propertySchema, value);
  return value;
}

// LLMs often send "post" for "POST"; accept a unique case-insensitive match.
function canonicalizeEnum(enumValues, value) {
  if (!enumValues || typeof value !== "string" || enumValues.includes(value)) return value;
  const matches = enumValues.filter((enumValue) => typeof enumValue === "string" && enumValue.toLowerCase() === value.toLowerCase());
  return matches.length === 1 ? matches[0] : value;
}

function coerceValue(declaredType, rawValue) {
  if (typeof rawValue === "number") return coerceNumber(declaredType, rawValue);
  if (typeof rawValue !== "string") return rawValue;
  const trimmed = rawValue.trim();
  if ((declaredType === "integer" || declaredType === "number") && trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  if (declaredType === "boolean" && BOOLEAN_STRINGS.has(trimmed.toLowerCase())) return BOOLEAN_STRINGS.get(trimmed.toLowerCase());
  if ((declaredType === "array" && trimmed.startsWith("[")) || (declaredType === "object" && trimmed.startsWith("{"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

// Numeric ids inside string arrays (e.g. `[123, 456]`) get the same exact-string treatment as scalars.
function coerceArrayItems(propertySchema, value) {
  if (!Array.isArray(value) || propertySchema.items?.type !== "string") return value;
  return value.map((item) => (typeof item === "number" ? coerceNumber("string", item) : item));
}

// IDs often arrive as numbers (unquoted YAML, LLM tool calls); keep them exact.
function coerceNumber(declaredType, numericValue) {
  if (declaredType === "boolean" && (numericValue === 0 || numericValue === 1)) return numericValue === 1;
  if (declaredType !== "string") return numericValue;
  if (Number.isInteger(numericValue) && !Number.isSafeInteger(numericValue)) {
    throw new PluginError(`Number ${numericValue} is too large to be exact; quote it as a string`, { kind: "invalid_input" });
  }
  return String(numericValue);
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
