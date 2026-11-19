/**
 * Wire encodings for declarative REST requests: query arrays (comma, repeat, brackets), x-www-form-urlencoded
 * bodies with bracket nesting (`metadata[order]=`, `tags[]=`, `items[0][price]=`), multipart fields and text bodies
 * (plain strings or NDJSON).
 */

/**
 * Appends one query value in the given array style.
 *
 * @param queryEntries - `[name, value]` pairs being built; mutated (Array)
 * @param wireName - Query name (string)
 * @param value - Value (any)
 * @param style - "comma" (a,b), "repeat" (k=a&k=b) or "brackets" (k[]=a&k[]=b) (string, default "comma")
 * @returns Nothing
 */
export function appendQueryValue(queryEntries, wireName, value, style = "comma") {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || style === "comma") return void queryEntries.push([wireName, encodeScalarOrList(value)]);
  const repeatedName = style === "brackets" ? `${wireName}[]` : wireName;
  for (const item of value) queryEntries.push([repeatedName, encodeScalar(item)]);
}

function encodeScalarOrList(value) {
  const isPrimitiveList = Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null);
  return isPrimitiveList ? value.join(",") : encodeScalar(value);
}

function encodeScalar(value) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Appends query entries to a path.
 *
 * @param path - Path without a query (string)
 * @param queryEntries - `[name, value]` pairs (Array)
 * @returns Path with `?query` when there are entries (string)
 */
export function appendQueryString(path, queryEntries) {
  if (queryEntries.length === 0) return path;
  return `${path}?${new URLSearchParams(queryEntries).toString()}`;
}

/**
 * Encodes a nested object as an x-www-form-urlencoded body with bracket keys.
 *
 * @param body - Nested body object (object)
 * @param arrayStyle - "brackets" (tags[]=a), "repeat" (tags=a) or "indexed" (tags[0]=a) (string)
 * @returns Encoded body (string)
 *
 * @example
 * encodeFormBody({ metadata: { order: "o1" }, tags: ["x"] }, "brackets"); // "metadata%5Border%5D=o1&tags%5B%5D=x"
 */
export function encodeFormBody(body, arrayStyle = "brackets") {
  const formEntries = [];
  flattenFormValue(formEntries, "", body, arrayStyle);
  return new URLSearchParams(formEntries).toString();
}

/**
 * Flattens a nested value into `[bracketKey, string]` pairs, as Stripe-style form encoding does.
 *
 * @param formEntries - Pairs being built; mutated (Array)
 * @param prefix - Key so far, "" at the top (string)
 * @param value - Value to flatten (any)
 * @param arrayStyle - See encodeFormBody (string)
 * @returns Nothing
 */
export function flattenFormValue(formEntries, prefix, value, arrayStyle) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) return flattenFormArray(formEntries, prefix, value, arrayStyle);
  if (typeof value === "object" && !(value instanceof Blob)) {
    for (const [key, nestedValue] of Object.entries(value)) flattenFormValue(formEntries, prefix ? `${prefix}[${key}]` : key, nestedValue, arrayStyle);
    return;
  }
  formEntries.push([prefix, value instanceof Blob ? value : String(value)]);
}

function flattenFormArray(formEntries, prefix, items, arrayStyle) {
  items.forEach((item, index) => {
    const isNested = item !== null && typeof item === "object";
    const useIndex = arrayStyle === "indexed" || isNested;
    const itemKey = useIndex ? `${prefix}[${index}]` : arrayStyle === "repeat" ? prefix : `${prefix}[]`;
    flattenFormValue(formEntries, itemKey, item, arrayStyle);
  });
}

/**
 * Encodes a text body: a string as is, an array as NDJSON (one JSON value per line, trailing newline).
 *
 * @param value - String or array (string | Array)
 * @returns Body text (string)
 */
export function encodeTextBody(value) {
  if (Array.isArray(value)) return value.map((item) => `${JSON.stringify(item)}\n`).join("");
  return String(value);
}
