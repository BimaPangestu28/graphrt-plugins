/**
 * Firestore typed values (https://firebase.google.com/docs/firestore/reference/rest/v1/Value).
 *
 * `value_format: "plain"` (default):
 *   - In: null, booleans, safe integers (integerValue), other finite numbers (doubleValue), strings, arrays and
 *     objects (mapValue). Types JSON lacks are written as one-key objects in Firestore's own form:
 *     {"timestampValue": "2026-11-19T10:00:00Z"}, {"bytesValue": "<base64>"}, {"referenceValue": "projects/..."},
 *     {"geoPointValue": {"latitude": -6.2, "longitude": 106.8}}, {"integerValue": "<int64 text>"}, {"doubleValue": 2}.
 *   - Out: the same JSON; integers that a JSON number cannot hold exactly stay strings, timestamps are RFC 3339
 *     text, bytes base64 and references their resource name.
 * `value_format: "typed"`: Firestore Value JSON in and out, checked for shape before it is sent.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const WRAPPER_KEYS = new Set(["timestampValue", "bytesValue", "referenceValue", "geoPointValue", "integerValue", "doubleValue"]);
const VALUE_KEYS = new Set(["nullValue", "booleanValue", "integerValue", "doubleValue", "timestampValue", "stringValue", "bytesValue", "referenceValue", "geoPointValue", "arrayValue", "mapValue"]);
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const SIMPLE_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Encodes one plain JSON value.
 *
 * @param value - Plain value or typed wrapper (any)
 * @param path - Field path, for messages (string, default "value")
 * @returns Firestore Value (object)
 * @throws PluginError kind `invalid_input` - Inexact or non-finite numbers, bad wrappers, nested arrays
 */
export function encodeValue(value, path = "value") {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return encodeNumber(value, path);
  if (Array.isArray(value)) return { arrayValue: { values: value.map((element, index) => encodeArrayElement(element, `${path}[${index}]`)) } };
  if (typeof value === "object") return isWrapper(value) ? checkWrapper(value, path) : { mapValue: { fields: encodePlainMap(value, path) } };
  throw invalidValue(`\`${path}\` is ${value === undefined ? "undefined" : `a ${typeof value}`}; use JSON values`);
}

function encodeNumber(value, path) {
  if (!Number.isFinite(value)) throw invalidValue(`\`${path}\` must be a finite number`);
  if (!Number.isInteger(value)) return { doubleValue: value };
  if (!Number.isSafeInteger(value)) throw invalidValue(`\`${path}\` is too large to be exact; write {"integerValue": "<digits>"}`);
  return { integerValue: String(value) };
}

// Firestore arrays cannot directly contain arrays.
function encodeArrayElement(element, path) {
  if (Array.isArray(element)) throw invalidValue(`\`${path}\`: Firestore does not allow an array directly inside an array; wrap it in an object`);
  return encodeValue(element, path);
}

function encodePlainMap(objectValue, path) {
  return Object.fromEntries(Object.entries(objectValue).map(([fieldName, fieldValue]) => [fieldName, encodeValue(fieldValue, `${path}.${fieldName}`)]));
}

function isWrapper(value) {
  const keys = Object.keys(value);
  return keys.length === 1 && WRAPPER_KEYS.has(keys[0]);
}

// [predicate, problem] per wrapper type; the problem names what a valid value looks like.
const WRAPPER_CHECKS = {
  timestampValue: [(inner) => typeof inner === "string" && RFC3339_PATTERN.test(inner), "must be an RFC 3339 timestamp such as 2026-11-19T10:00:00Z"],
  bytesValue: [(inner) => typeof inner === "string" && BASE64_PATTERN.test(inner), "must be base64 text"],
  referenceValue: [(inner) => typeof inner === "string" && /^projects\/[^/]+\/databases\/[^/]+\/documents\/.+/.test(inner), "must be projects/<p>/databases/<db>/documents/<path>"],
  integerValue: [(inner) => typeof inner === "string" && /^-?\d{1,19}$/.test(inner), "must be integer digits as text"],
  doubleValue: [(inner) => typeof inner === "number", "must be a number"],
  geoPointValue: [isGeoPoint, "needs a latitude from -90 to 90 and a longitude from -180 to 180"],
};

function checkWrapper(wrapper, path) {
  const [[typeName, inner]] = Object.entries(wrapper);
  const [isValid, problem] = WRAPPER_CHECKS[typeName];
  if (!isValid(inner)) throw invalidValue(`\`${path}.${typeName}\` ${problem}`);
  return { [typeName]: inner };
}

function isGeoPoint(geoPoint) {
  const { latitude, longitude } = geoPoint ?? {};
  return typeof latitude === "number" && latitude >= -90 && latitude <= 90 && typeof longitude === "number" && longitude >= -180 && longitude <= 180;
}

/**
 * Encodes a document's fields.
 *
 * @param fields - Field map (object)
 * @param valueFormat - "plain" or "typed" (string, default "plain")
 * @returns Map of field name to Firestore Value (object)
 * @throws PluginError kind `invalid_input`
 */
export function encodeFields(fields, valueFormat = "plain") {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw invalidValue("`fields` must be an object");
  if (valueFormat !== "typed") return encodePlainMap(fields, "fields");
  for (const [fieldName, fieldValue] of Object.entries(fields)) assertFirestoreValue(fieldValue, `fields.${fieldName}`);
  return fields;
}

/**
 * Checks the shape of a Firestore Value (one known key; arrays and maps recursively).
 *
 * @param value - Candidate (any)
 * @param path - For messages (string)
 * @throws PluginError kind `invalid_input`
 */
export function assertFirestoreValue(value, path) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.length !== 1 || !VALUE_KEYS.has(keys[0])) throw invalidValue(`\`${path}\` is not a Firestore value such as {"stringValue": "x"}`);
  const [typeName] = keys;
  if (typeName === "arrayValue") (value.arrayValue?.values ?? []).forEach((element, index) => assertFirestoreValue(element, `${path}[${index}]`));
  if (typeName === "mapValue") Object.entries(value.mapValue?.fields ?? {}).forEach(([fieldName, fieldValue]) => assertFirestoreValue(fieldValue, `${path}.${fieldName}`));
}

/**
 * Decodes one Firestore Value to plain JSON.
 *
 * @param value - Firestore Value (object)
 * @returns Plain value (any)
 */
export function decodeValue(value) {
  if ("integerValue" in value) {
    const parsed = Number(value.integerValue);
    return Number.isSafeInteger(parsed) ? parsed : value.integerValue;
  }
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  const [inner] = Object.values(value);
  return inner;
}

/**
 * Decodes a document's fields.
 *
 * @param fields - Map of Firestore Values (object | undefined)
 * @param valueFormat - "plain" or "typed" (string, default "plain")
 * @returns Plain object, or the fields unchanged for "typed" (object)
 */
export function decodeFields(fields, valueFormat = "plain") {
  if (valueFormat === "typed") return fields ?? {};
  return Object.fromEntries(Object.entries(fields ?? {}).map(([fieldName, fieldValue]) => [fieldName, decodeValue(fieldValue)]));
}

/**
 * Condenses a Document resource to its id, relative path, fields and times.
 *
 * @param document - Firestore Document (object)
 * @param valueFormat - "plain" or "typed" (string, default "plain")
 * @returns `{id, path, fields, create_time, update_time}` (object)
 */
export function decodeDocument(document, valueFormat = "plain") {
  const relativePath = String(document.name ?? "").split("/documents/").slice(1).join("/documents/");
  const decodedPath = relativePath.split("/").map(safeDecode).join("/");
  return {
    id: decodedPath.split("/").at(-1) ?? null,
    path: decodedPath,
    fields: decodeFields(document.fields, valueFormat),
    create_time: document.createTime ?? null,
    update_time: document.updateTime ?? null,
  };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Quotes one field name for a field path (update masks, projections): backticks unless it is a simple identifier.
 *
 * @param fieldName - Field name (string)
 * @returns Field path segment (string)
 *
 * @example
 * quoteFieldPath("first name"); // "`first name`"
 */
export function quoteFieldPath(fieldName) {
  if (SIMPLE_FIELD_NAME_PATTERN.test(fieldName)) return fieldName;
  return `\`${fieldName.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

function invalidValue(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
