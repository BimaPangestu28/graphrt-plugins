/**
 * Path access for the declarative REST layer.
 *
 * Syntax: dot-separated keys (`data.items.0.id`), `\.` for a literal dot (`@odata\.nextLink`), bracket-quoted keys
 * for any key (`["@odata.nextLink"]`, `meta["a.b"]`) and `[]` to flatten an array (`data[].url`, for
 * collectPathValues and replacePathValues). Only own properties are read, and prototype keys are never written.
 * writePath creates plain objects for every missing segment, also numeric ones (`items.0.id` gives
 * `{items: {"0": {id}}}`, not an array).
 */

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const FLATTEN = Symbol("flatten []");

/**
 * Splits a path into keys and FLATTEN markers.
 *
 * @param pathText - Path such as 'a["b.c"][].d' (string)
 * @returns Segments: strings and `parsePath.FLATTEN` (Array<string | symbol>)
 * @throws Error - On an unterminated bracket or quote
 *
 * @example
 * parsePath('value[].["@odata.id"]'); // ["value", FLATTEN, "@odata.id"]
 */
export function parsePath(pathText) {
  const segments = [];
  let currentKey = "";
  let hasKey = false;
  const flushKey = () => {
    if (hasKey) segments.push(currentKey);
    currentKey = "";
    hasKey = false;
  };
  for (let index = 0; index < pathText.length; index += 1) {
    const character = pathText[index];
    if (character === "\\" && index + 1 < pathText.length) {
      currentKey += pathText[(index += 1)];
      hasKey = true;
    } else if (character === ".") {
      flushKey();
    } else if (character === "[") {
      flushKey();
      index = readBracket(pathText, index, segments);
    } else {
      currentKey += character;
      hasKey = true;
    }
  }
  flushKey();
  return segments;
}
parsePath.FLATTEN = FLATTEN;

function readBracket(pathText, openIndex, segments) {
  if (pathText[openIndex + 1] === "]") {
    segments.push(FLATTEN);
    return openIndex + 1;
  }
  const quote = pathText[openIndex + 1];
  const closeIndex = quote === '"' || quote === "'" ? pathText.indexOf(`${quote}]`, openIndex + 2) : -1;
  if (closeIndex === -1) throw new Error(`Malformed path ${JSON.stringify(pathText)}: use ["key"] or [] inside brackets`);
  segments.push(pathText.slice(openIndex + 2, closeIndex));
  return closeIndex + 1;
}

/**
 * Reads a value at a path. Numeric segments index arrays.
 *
 * @param value - Object to read from (any)
 * @param pathText - Path; empty or undefined returns `value` (string)
 * @returns The value, or undefined when any segment is missing (any)
 *
 * @example
 * readPath({ meta: { next: "c2" } }, "meta.next"); // "c2"
 */
export function readPath(value, pathText) {
  if (pathText === undefined || pathText === "") return value;
  return parsePath(pathText).reduce((current, segment) => (segment === FLATTEN ? current : readOwn(current, segment)), value);
}

/**
 * Writes a value at a path, creating intermediate objects.
 *
 * @param target - Object to write into; mutated (object)
 * @param pathText - Path such as "message.text" (string)
 * @param value - Value to store (any)
 * @returns The target (object)
 * @throws Error - When a segment is `__proto__`, `prototype` or `constructor`, or the path has `[]`
 */
export function writePath(target, pathText, value) {
  const segments = parsePath(pathText);
  assertWritableSegments(segments, pathText);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainContainer(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
  return target;
}

/**
 * Lists the segments of a path that writePath would refuse.
 *
 * @param pathText - Path (string)
 * @returns Forbidden segment names, empty when the path is writable (string[])
 */
export function findForbiddenSegments(pathText) {
  return parsePath(pathText).filter((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

function assertWritableSegments(segments, pathText) {
  const forbiddenSegment = segments.find((segment) => FORBIDDEN_SEGMENTS.has(segment));
  if (forbiddenSegment) throw new Error(`Refusing to write the path segment "${forbiddenSegment}" in ${pathText}`);
  if (segments.includes(FLATTEN) || segments.length === 0) throw new Error(`Cannot write to the path ${JSON.stringify(pathText)}`);
}

/**
 * Collects every value at a path where `[]` flattens an array, e.g. "data[].url". A final array is flattened too.
 *
 * @param value - Object to read from (any)
 * @param pathText - Path, optionally with `[]` after array segments (string)
 * @returns Defined values found (Array<any>)
 *
 * @example
 * collectPathValues({ data: [{ url: "a" }, { url: "b" }] }, "data[].url"); // ["a", "b"]
 */
export function collectPathValues(value, pathText) {
  return collectSegments(value, parsePath(pathText));
}

function collectSegments(value, segments) {
  const flattenIndex = segments.indexOf(FLATTEN);
  if (flattenIndex === -1) return flattenDefined(segments.reduce(readOwn, value));
  const arrayValue = segments.slice(0, flattenIndex).reduce(readOwn, value);
  if (!Array.isArray(arrayValue)) return [];
  return arrayValue.flatMap((item) => collectSegments(item, segments.slice(flattenIndex + 1)));
}

/**
 * Returns a copy of `value` with every value at the path replaced by `mapValue(value)`.
 *
 * @param value - Object to copy (any)
 * @param pathText - Path, optionally with `[]` segments (string)
 * @param mapValue - `(foundValue) => replacement` (function)
 * @returns New value; untouched branches are shared with the input (any)
 */
export function replacePathValues(value, pathText, mapValue) {
  return replaceSegments(value, parsePath(pathText), mapValue);
}

function replaceSegments(value, segments, mapValue) {
  if (segments.length === 0) return value === undefined || value === null ? value : mapValue(value);
  const [segment, ...rest] = segments;
  if (segment === FLATTEN) return Array.isArray(value) ? value.map((item) => replaceSegments(item, rest, mapValue)) : value;
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  copy[segment] = replaceSegments(value[segment], rest, mapValue);
  return copy;
}

function readOwn(current, segment) {
  if (current === null || typeof current !== "object") return undefined;
  return Object.hasOwn(current, segment) ? current[segment] : undefined;
}

function isPlainContainer(candidate) {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function flattenDefined(candidate) {
  const values = Array.isArray(candidate) ? candidate : [candidate];
  return values.filter((item) => item !== undefined && item !== null);
}
