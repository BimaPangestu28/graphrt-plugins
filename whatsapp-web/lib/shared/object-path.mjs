/**
 * Dotted-path access for the declarative REST layer: `readPath(body, "data.items.0.id")`,
 * `writePath(body, "message.text", value)` and `collectPathValues(result, "data[].url")`.
 * Only own properties are read, and prototype keys are never written.
 */

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Reads a value at a dotted path. Numeric segments index arrays.
 *
 * @param value - Object to read from (any)
 * @param dottedPath - Path such as "data.items.0.id"; empty or undefined returns `value` (string)
 * @returns The value, or undefined when any segment is missing (any)
 *
 * @example
 * readPath({ meta: { next: "c2" } }, "meta.next"); // "c2"
 */
export function readPath(value, dottedPath) {
  if (dottedPath === undefined || dottedPath === "") return value;
  return splitPath(dottedPath).reduce((current, segment) => readOwn(current, segment), value);
}

/**
 * Writes a value at a dotted path, creating intermediate objects.
 *
 * @param target - Object to write into; mutated (object)
 * @param dottedPath - Path such as "message.text" (string)
 * @param value - Value to store (any)
 * @returns The target (object)
 * @throws Error - When a segment is `__proto__`, `prototype` or `constructor`
 */
export function writePath(target, dottedPath, value) {
  const segments = splitPath(dottedPath);
  const forbiddenSegment = segments.find((segment) => FORBIDDEN_SEGMENTS.has(segment));
  if (forbiddenSegment) throw new Error(`Refusing to write the path segment "${forbiddenSegment}" in ${dottedPath}`);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainContainer(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
  return target;
}

/**
 * Collects every value at a path where `[]` flattens an array, e.g. "data[].url". A final array is flattened too.
 *
 * @param value - Object to read from (any)
 * @param dottedPath - Path, optionally with `[]` after array segments (string)
 * @returns Defined values found (Array<any>)
 *
 * @example
 * collectPathValues({ data: [{ url: "a" }, { url: "b" }] }, "data[].url"); // ["a", "b"]
 */
export function collectPathValues(value, dottedPath) {
  const [head, ...rest] = dottedPath.split("[]");
  const headValue = readPath(value, trimDots(head));
  if (rest.length === 0) return flattenDefined(headValue);
  if (!Array.isArray(headValue)) return [];
  const remainingPath = trimDots(rest.join("[]"));
  return headValue.flatMap((item) => (remainingPath === "" ? flattenDefined(item) : collectPathValues(item, remainingPath)));
}

function splitPath(dottedPath) {
  return String(dottedPath).split(".");
}

function readOwn(current, segment) {
  if (current === null || typeof current !== "object") return undefined;
  return Object.hasOwn(current, segment) ? current[segment] : undefined;
}

function isPlainContainer(candidate) {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function trimDots(pathText) {
  return pathText.replace(/^\.+|\.+$/g, "");
}

function flattenDefined(candidate) {
  const values = Array.isArray(candidate) ? candidate : [candidate];
  return values.filter((item) => item !== undefined && item !== null);
}
