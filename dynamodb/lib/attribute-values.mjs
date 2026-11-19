/**
 * DynamoDB AttributeValue encoding.
 *
 * Two modes per call (`attribute_format`):
 *   - "plain" (default): ordinary JSON in and out. string -> S, number -> N, boolean -> BOOL, null -> NULL,
 *     array -> L, object -> M. Read back, N becomes a number when that is exact and a string otherwise
 *     (so 30-digit numbers are never rounded), SS/NS/BS sets become arrays and B is base64 text.
 *   - "typed": DynamoDB JSON ({"S": "x"}, {"SS": [...]}, {"N": "1.50"}) in and out, for sets, binary and exact
 *     numbers. The shape of every value is checked before it is sent.
 * Pagination cursors are the LastEvaluatedKey as base64url JSON, checked when they come back.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const SCALAR_TYPES = { S: "string", N: "string", B: "string", BOOL: "boolean", NULL: "boolean" };
const SET_TYPES = new Set(["SS", "NS", "BS"]);

/**
 * Encodes one plain JSON value as an AttributeValue.
 *
 * @param value - JSON value (any)
 * @param path - Attribute path, for messages (string, default "value")
 * @returns AttributeValue (object)
 * @throws PluginError kind `invalid_input` - undefined, non-finite or inexact numbers
 */
export function marshallValue(value, path = "value") {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "number") return { N: formatNumber(value, path) };
  if (Array.isArray(value)) return { L: value.map((element, index) => marshallValue(element, `${path}[${index}]`)) };
  if (typeof value === "object") return { M: marshallMap(value, path) };
  throw invalidValue(`\`${path}\` is ${value === undefined ? "undefined" : `a ${typeof value}`}; use JSON values`);
}

function formatNumber(value, path) {
  if (!Number.isFinite(value)) throw invalidValue(`\`${path}\` must be a finite number`);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw invalidValue(`\`${path}\` is too large to be exact; use attribute_format "typed" with {"N": "..."}`);
  return String(value);
}

function marshallMap(objectValue, path) {
  return Object.fromEntries(Object.entries(objectValue).map(([attributeName, attributeValue]) => [attributeName, marshallValue(attributeValue, `${path}.${attributeName}`)]));
}

/**
 * Encodes an item, key or expression-values map.
 *
 * @param plainOrTyped - Map of attribute name to value (object)
 * @param attributeFormat - "plain" or "typed" (string, default "plain")
 * @param label - Argument name, for messages (string, default "item")
 * @returns Map of attribute name to AttributeValue (object)
 * @throws PluginError kind `invalid_input` - Not an object, or a value that cannot be encoded / is not an AttributeValue
 */
export function marshallItem(plainOrTyped, attributeFormat = "plain", label = "item") {
  if (!plainOrTyped || typeof plainOrTyped !== "object" || Array.isArray(plainOrTyped)) throw invalidValue(`\`${label}\` must be an object`);
  if (attributeFormat !== "typed") return marshallMap(plainOrTyped, label);
  for (const [attributeName, attributeValue] of Object.entries(plainOrTyped)) assertAttributeValue(attributeValue, `${label}.${attributeName}`);
  return plainOrTyped;
}

/**
 * Checks that a value is a well-formed AttributeValue (exactly one known type key with a value of the right type).
 *
 * @param attributeValue - Candidate (any)
 * @param path - For messages (string)
 * @throws PluginError kind `invalid_input`
 */
export function assertAttributeValue(attributeValue, path) {
  const typeNames = attributeValue && typeof attributeValue === "object" && !Array.isArray(attributeValue) ? Object.keys(attributeValue) : [];
  const [typeName] = typeNames;
  const inner = attributeValue?.[typeName];
  const isValid =
    typeNames.length === 1 &&
    ((SCALAR_TYPES[typeName] && typeof inner === SCALAR_TYPES[typeName]) ||
      (SET_TYPES.has(typeName) && Array.isArray(inner) && inner.every((member) => typeof member === "string")) ||
      (typeName === "L" && Array.isArray(inner)) ||
      (typeName === "M" && inner && typeof inner === "object" && !Array.isArray(inner)));
  if (!isValid) throw invalidValue(`\`${path}\` is not a DynamoDB AttributeValue such as {"S": "text"} or {"N": "1"}`);
  if (typeName === "L") inner.forEach((element, index) => assertAttributeValue(element, `${path}[${index}]`));
  if (typeName === "M") Object.entries(inner).forEach(([name, element]) => assertAttributeValue(element, `${path}.${name}`));
}

/**
 * Decodes one AttributeValue to plain JSON.
 *
 * @param attributeValue - AttributeValue (object)
 * @returns Plain value (any)
 */
export function unmarshallValue(attributeValue) {
  const [[typeName, inner]] = Object.entries(attributeValue);
  if (typeName === "N") return parseNumber(inner);
  if (typeName === "NS") return inner.map(parseNumber);
  if (typeName === "NULL") return null;
  if (typeName === "L") return inner.map(unmarshallValue);
  if (typeName === "M") return unmarshallItem(inner);
  return inner;
}

// "42" -> 42 and "0.25" -> 0.25, but "12345678901234567890" or "1.10" stay strings (a number would change them).
function parseNumber(numberText) {
  const parsed = Number(numberText);
  return Number.isFinite(parsed) && String(parsed) === numberText ? parsed : numberText;
}

/**
 * Decodes an item in the requested format.
 *
 * @param item - Map of AttributeValues, or undefined (object | undefined)
 * @param attributeFormat - "plain" or "typed" (string, default "plain")
 * @returns Plain object, the item unchanged for "typed", or null when there is no item (object | null)
 */
export function unmarshallItem(item, attributeFormat = "plain") {
  if (!item) return null;
  if (attributeFormat === "typed") return item;
  return Object.fromEntries(Object.entries(item).map(([attributeName, attributeValue]) => [attributeName, unmarshallValue(attributeValue)]));
}

/**
 * Encodes a LastEvaluatedKey as an opaque cursor.
 *
 * @param lastEvaluatedKey - From a Query or Scan response (object | undefined)
 * @returns base64url cursor, or null at the end (string | null)
 */
export function encodeCursor(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  return Buffer.from(JSON.stringify(lastEvaluatedKey), "utf8").toString("base64url");
}

/**
 * Decodes a cursor back into an ExclusiveStartKey.
 *
 * @param cursor - From encodeCursor (string)
 * @returns ExclusiveStartKey (object)
 * @throws PluginError kind `invalid_input` - When the cursor is not one this plugin produced
 */
export function decodeCursor(cursor) {
  try {
    const startKey = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    marshallItem(startKey, "typed", "cursor");
    return startKey;
  } catch {
    throw invalidValue("`cursor` is not a next_cursor returned by this operation");
  }
}

function invalidValue(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
